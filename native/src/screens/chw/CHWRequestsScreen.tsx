/**
 * CHWRequestsScreen — Members screen (renamed in new design, same data).
 *
 * Re-skinned to the new design system (AppShell + Card + Pill + PageHeader).
 * Behavior, hooks, mutations, and navigation are identical to the original.
 *
 * Tab strip:
 *   My Members     — accepted requests (members active with this CHW)
 *   Pending Requests — open requests inbox with Accept / Pass (was the original default view)
 *   Inactive        — passed/dismissed requests
 *
 * Multi-select vertical filter chips appear within the Pending Requests tab.
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  Alert,
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Platform,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  CheckCircle,
  XCircle,
  Inbox,
  Home,
  Utensils,
  Brain,
  Bus,
  Briefcase,
  Stethoscope,
  Bell,
  ThumbsDown,
  Lock,
  User,
  Users,
  UserX,
} from 'lucide-react-native';
import type { CHWSessionsStackParamList } from '../../navigation/CHWTabNavigator';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { colors as tokens } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';
import {
  type Vertical,
  VERTICAL_LABEL,
  VERTICAL_COLOR,
  VERTICAL_FILTER_OPTIONS,
} from '../../lib/verticals';
import {
  useRequests,
  useAcceptRequest,
  usePassRequest,
  type ServiceRequestData,
} from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';

import {
  AppShell,
  PageHeader,
  Card,
  Pill,
} from '../../components/ui';

// ─── Constants (sourced from lib/verticals — single source of truth) ──────────

const FILTER_VERTICALS: ReadonlyArray<{ key: Vertical; label: string }> =
  VERTICAL_FILTER_OPTIONS;

const VERTICAL_COLORS: Record<Vertical, string> = VERTICAL_COLOR;
const VERTICAL_LABELS: Record<Vertical, string> = VERTICAL_LABEL;

const SESSION_MODE_LABELS: Record<string, string> = {
  in_person: 'In Person',
  virtual: 'Video Call',
  phone: 'Phone',
};

// Urgency-pill colors. Real data, sourced from request.urgency.
const URGENCY_COLORS: Record<string, string> = {
  routine: '#22C55E',
  soon: '#F59E0B',
  urgent: '#EF4444',
};
const URGENCY_LABELS: Record<string, string> = {
  routine: 'Routine',
  soon: 'Soon',
  urgent: 'Urgent',
};

// ─── Tab type ─────────────────────────────────────────────────────────────────

type MembersTab = 'my_members' | 'pending_requests' | 'inactive';

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
    case 'transportation':
      return <Bus size={size} color={iconColor} />;
    case 'food':
      return <Utensils size={size} color={iconColor} />;
    case 'mental_health':
      return <Brain size={size} color={iconColor} />;
    case 'healthcare':
      return <Stethoscope size={size} color={iconColor} />;
    case 'employment':
      return <Briefcase size={size} color={iconColor} />;
  }
}

// ─── RequestCard sub-component ────────────────────────────────────────────────

type RequestsNavProp = NativeStackNavigationProp<CHWSessionsStackParamList, 'Sessions'>;

interface RequestCardProps {
  request: ServiceRequestData;
  onAccept: (id: string) => void;
  onPass: (id: string) => void;
  /** When true, renders the accepted-state UI with a "View Member Profile" link. */
  isAccepted?: boolean;
  onViewMemberProfile?: (memberId: string) => void;
}

function RequestCard({
  request,
  onAccept,
  onPass,
  isAccepted = false,
  onViewMemberProfile,
}: RequestCardProps): React.JSX.Element {
  // Use the authoritative verticals array; fall back to [vertical] for rows
  // created before the multi-vertical migration.
  const effectiveVerticals: string[] =
    request.verticals && request.verticals.length > 0
      ? request.verticals
      : [request.vertical];

  // Primary vertical drives the icon and accessibility label.
  const primaryVertical = effectiveVerticals[0] as Vertical;
  const primaryColor = VERTICAL_COLORS[primaryVertical] ?? '#6B7A6B';

  const urgencyLabel = URGENCY_LABELS[request.urgency] ?? request.urgency;

  // Joined label for display: "Housing • Mental Health • Food Security"
  const verticalsLabel = effectiveVerticals
    .map((v) => VERTICAL_LABELS[v as Vertical] ?? v)
    .join(' • ');

  return (
    <Card style={cardStyles.card}>
      {/* Header row — vertical icon + category badges + urgency badge.
          Member name + description are intentionally hidden until accept
          per HIPAA minimum-necessary (45 CFR §164.514(d)). The summary
          endpoint omits them; the card mirrors that on the wire. */}
      <View style={cardStyles.headerRow}>
        <View style={[cardStyles.iconCircle, { backgroundColor: primaryColor + '18' }]}>
          <VerticalIconComponent vertical={primaryVertical} size={18} />
        </View>
        <View style={cardStyles.headerContent}>
          <View style={cardStyles.titleRow}>
            <Text style={cardStyles.cardTitle}>
              {verticalsLabel} request
            </Text>
            {isAccepted ? (
              <Pill variant="emerald" size="sm">Accepted</Pill>
            ) : null}
          </View>
          <View style={cardStyles.badgeRow}>
            {/* Render one badge per vertical */}
            {effectiveVerticals.map((v) => (
              <Pill key={v} variant="gray" size="sm">
                {VERTICAL_LABELS[v as Vertical] ?? v}
              </Pill>
            ))}
            <Pill
              variant={
                request.urgency === 'urgent' ? 'red'
                : request.urgency === 'soon' ? 'amber'
                : 'emerald'
              }
              size="sm"
            >
              {urgencyLabel}
            </Pill>
            <Text style={cardStyles.modeLabel}>
              · {SESSION_MODE_LABELS[request.preferredMode] ?? request.preferredMode}
            </Text>
          </View>
        </View>
      </View>

      {/* On accepted requests: show member name (now visible) + profile link.
          On open requests: HIPAA privacy notice. */}
      {isAccepted ? (
        <View style={cardStyles.acceptedMemberRow}>
          {request.memberName ? (
            <Text style={cardStyles.acceptedMemberName}>{request.memberName}</Text>
          ) : null}
          {request.memberId && onViewMemberProfile ? (
            <TouchableOpacity
              style={cardStyles.viewProfileLink}
              onPress={() => onViewMemberProfile(request.memberId)}
              accessibilityRole="button"
              accessibilityLabel={`View profile for ${request.memberName ?? 'this member'}`}
            >
              <User size={13} color="#3D5A3E" />
              <Text style={cardStyles.viewProfileLinkText}>View Member Profile</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        <View style={cardStyles.privacyNote}>
          <Lock size={12} color={colors.mutedForeground} />
          <Text style={cardStyles.privacyText}>
            Member name and details revealed after you accept (HIPAA minimum necessary).
          </Text>
        </View>
      )}

      {/* Action buttons — only shown on open requests. Accepted requests
          already have a session created and don't need these controls here. */}
      {!isAccepted ? (
        <View style={cardStyles.actionRow}>
          <TouchableOpacity
            style={cardStyles.acceptButton}
            onPress={() => onAccept(request.id)}
            accessibilityLabel={`Accept ${verticalsLabel} request`}
            accessibilityRole="button"
          >
            <CheckCircle size={15} color="#FFFFFF" />
            <Text style={cardStyles.acceptButtonText}>Accept</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={cardStyles.passButton}
            onPress={() => onPass(request.id)}
            accessibilityLabel={`Pass on ${verticalsLabel} request`}
            accessibilityRole="button"
          >
            <XCircle size={15} color={colors.mutedForeground} />
            <Text style={cardStyles.passButtonText}>Pass</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </Card>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    padding: 20,
    marginBottom: 12,
  } as ViewStyle,
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 10,
  } as ViewStyle,
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  } as ViewStyle,
  acceptedMemberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 2,
    marginBottom: 4,
    flexWrap: 'wrap',
  } as ViewStyle,
  acceptedMemberName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#1E3320',
    flex: 1,
  } as TextStyle,
  viewProfileLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3D5A3E40',
    backgroundColor: '#3D5A3E10',
  } as ViewStyle,
  viewProfileLinkText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#3D5A3E',
  } as TextStyle,
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 2,
    backgroundColor: '#3D5A3E15',
  } as ViewStyle,
  headerContent: {
    flex: 1,
    gap: 4,
  } as ViewStyle,
  cardTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    lineHeight: 20,
    color: '#111827',
    marginBottom: 4,
  } as TextStyle,
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,
  modeLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
  } as TextStyle,
  privacyNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 8,
    marginBottom: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#F4F1ED',
    borderLeftWidth: 3,
    borderLeftColor: colors.mutedForeground,
  } as ViewStyle,
  privacyText: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: colors.mutedForeground,
    lineHeight: 16,
  } as TextStyle,
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  } as ViewStyle,
  acceptButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#3D5A3E',
    paddingVertical: 14,
    borderRadius: 12,
  } as ViewStyle,
  acceptButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  } as TextStyle,
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
  } as ViewStyle,
  passButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#6B7A6B',
  } as TextStyle,
});

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * CHW Members screen — tab strip surfaces My Members / Pending Requests / Inactive.
 * All original hook calls and mutations are preserved exactly.
 */
export function CHWRequestsScreen(): React.JSX.Element {
  // Active tab state — defaults to "My Members" to match new design intent.
  const [activeTab, setActiveTab] = useState<MembersTab>('my_members');

  // Multi-select vertical filter (used inside Pending Requests tab).
  const [selectedVerticals, setSelectedVerticals] = useState<Set<Vertical>>(new Set());

  const navigation = useNavigation<RequestsNavProp>();

  const { userName } = useAuth();
  const initials = useMemo(() => {
    if (!userName) return 'CW';
    return userName
      .split(' ')
      .map((n) => n[0] ?? '')
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }, [userName]);

  const { data: rawRequests, isLoading, error, refetch } = useRequests();
  const acceptRequest = useAcceptRequest();
  const passRequest = usePassRequest();
  const refresh = useRefreshControl([refetch]);

  // Track session-local accepted/passed counts for the summary stat row.
  const [acceptedCount, setAcceptedCount] = useState(0);
  const [passedCount, setPassedCount] = useState(0);

  // Session-local set of request IDs the CHW has passed on (see original comment).
  const [passedIds, setPassedIds] = useState<Set<string>>(() => new Set());

  const allOpenRequests = useMemo<ServiceRequestData[]>(
    () =>
      (rawRequests ?? []).filter(
        (r) => r.status === 'open' && !passedIds.has(r.id),
      ),
    [rawRequests, passedIds],
  );

  // Accepted requests matched to this CHW.
  const acceptedRequests = useMemo<ServiceRequestData[]>(
    () => (rawRequests ?? []).filter((r) => r.status === 'accepted'),
    [rawRequests],
  );

  // Passed/inactive requests.
  const inactiveRequests = useMemo<ServiceRequestData[]>(
    () =>
      (rawRequests ?? []).filter(
        (r) => r.status !== 'open' && r.status !== 'accepted',
      ),
    [rawRequests],
  );

  const filteredPendingRequests = useMemo<ServiceRequestData[]>(
    () =>
      selectedVerticals.size === 0
        ? allOpenRequests
        : allOpenRequests.filter((r) => {
            const effectiveVerticals =
              r.verticals && r.verticals.length > 0 ? r.verticals : [r.vertical];
            return effectiveVerticals.some((v) => selectedVerticals.has(v as Vertical));
          }),
    [selectedVerticals, allOpenRequests],
  );

  const toggleVertical = useCallback((v: Vertical) => {
    setSelectedVerticals((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setSelectedVerticals(new Set());
  }, []);

  const handleAccept = useCallback(async (id: string): Promise<void> => {
    try {
      await acceptRequest.mutateAsync(id);
      setAcceptedCount((prev) => prev + 1);
    } catch (err) {
      // Surface the failure to the CHW so they can retry. Without this the
      // optimistic UI would leave them thinking the request was accepted
      // while the row stays Pending in the backend (HIPAA + ops risk).
      Alert.alert(
        'Could not accept request',
        err instanceof Error ? err.message : 'Please check your connection and try again.',
      );
    }
  }, [acceptRequest]);

  const handlePass = useCallback(async (id: string): Promise<void> => {
    // Optimistic UI — hide the request immediately so the CHW's queue
    // updates without waiting for the server.
    setPassedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setPassedCount((prev) => prev + 1);
    try {
      await passRequest.mutateAsync(id);
    } catch (err) {
      // Roll back the optimistic hide and show an error toast — without this
      // a failed pass silently disappears from the list while the server
      // still has it Pending, leading to ghost requests.
      setPassedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setPassedCount((prev) => Math.max(0, prev - 1));
      Alert.alert(
        'Could not pass request',
        err instanceof Error ? err.message : 'Please check your connection and try again.',
      );
    }
  }, [passRequest]);

  const handleViewMemberProfile = useCallback((memberId: string): void => {
    navigation.navigate('MemberProfile', { memberId });
  }, [navigation]);

  const verticalCount = useCallback(
    (key: Vertical): number =>
      allOpenRequests.filter((r) => {
        const effectiveVerticals =
          r.verticals && r.verticals.length > 0 ? r.verticals : [r.vertical];
        return effectiveVerticals.includes(key as string);
      }).length,
    [allOpenRequests],
  );

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.pageWrap}>
          <View style={styles.headerBlock}>
            <Text style={styles.pageTitle}>Members</Text>
          </View>
          <View style={styles.listContent}>
            <LoadingSkeleton variant="rows" rows={4} />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ErrorState message="Failed to load members" onRetry={() => void refetch()} />
      </SafeAreaView>
    );
  }

  // ── Tab content ───────────────────────────────────────────────────────────────

  const renderMyMembers = () => (
    <FlatList
      data={acceptedRequests}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <RequestCard
          request={item}
          isAccepted
          onAccept={() => undefined}
          onPass={() => undefined}
          onViewMemberProfile={handleViewMemberProfile}
        />
      )}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      refreshControl={refresh.control}
      ListEmptyComponent={
        <View style={styles.emptyState}>
          <View style={styles.emptyIconCircle}>
            <Users size={24} color={colors.mutedForeground} />
          </View>
          <Text style={styles.emptyTitle}>No active members yet</Text>
          <Text style={styles.emptySubtext}>
            Accept a pending request to add a member to your caseload.
          </Text>
        </View>
      }
    />
  );

  const renderPendingRequests = () => (
    <>
      {/* Summary stat row */}
      <View style={styles.statSummaryRow}>
        <Card style={[styles.statSummaryCard, { borderColor: colors.compassGold + '50' }]}>
          <View style={[styles.statSummaryIcon, { backgroundColor: colors.compassGold + '18' }]}>
            <Bell size={14} color={colors.compassGold} />
          </View>
          <Text style={styles.statSummaryValue}>{allOpenRequests.length}</Text>
          <Text style={styles.statSummaryLabel}>New</Text>
        </Card>
        <Card style={[styles.statSummaryCard, { borderColor: colors.secondary + '50' }]}>
          <View style={[styles.statSummaryIcon, { backgroundColor: colors.secondary + '18' }]}>
            <CheckCircle size={14} color={colors.secondary} />
          </View>
          <Text style={styles.statSummaryValue}>{acceptedCount}</Text>
          <Text style={styles.statSummaryLabel}>Accepted</Text>
        </Card>
        <Card style={[styles.statSummaryCard, { borderColor: colors.destructive + '40' }]}>
          <View style={[styles.statSummaryIcon, { backgroundColor: colors.destructive + '18' }]}>
            <ThumbsDown size={14} color={colors.destructive} />
          </View>
          <Text style={styles.statSummaryValue}>{passedCount}</Text>
          <Text style={styles.statSummaryLabel}>Passed</Text>
        </Card>
      </View>

      {/* Multi-select vertical filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterChipsRow}
      >
        <TouchableOpacity
          style={[styles.filterChip, selectedVerticals.size === 0 && styles.filterChipActive]}
          onPress={clearFilters}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: selectedVerticals.size === 0 }}
          accessibilityLabel="Show all categories"
        >
          <Text style={[styles.filterChipText, selectedVerticals.size === 0 && styles.filterChipTextActive]}>
            All {allOpenRequests.length > 0 ? allOpenRequests.length : ''}
          </Text>
        </TouchableOpacity>
        {FILTER_VERTICALS.map((tab) => {
          const isSelected = selectedVerticals.has(tab.key);
          const count = verticalCount(tab.key);
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.filterChip, isSelected && styles.filterChipActive]}
              onPress={() => toggleVertical(tab.key)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isSelected }}
              accessibilityLabel={`Toggle ${tab.label} filter`}
            >
              <Text style={[styles.filterChipText, isSelected && styles.filterChipTextActive]}>
                {tab.label}
                {count > 0 ? ` ${count}` : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <FlatList
        data={filteredPendingRequests}
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
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <View style={styles.emptyIconCircle}>
              <Inbox size={24} color={colors.mutedForeground} />
            </View>
            <Text style={styles.emptyTitle}>No open requests</Text>
            <Text style={styles.emptySubtext}>
              {selectedVerticals.size === 0
                ? 'No open requests right now. Check back soon!'
                : 'No open requests in the selected categories. Try clearing filters.'}
            </Text>
          </View>
        }
      />
    </>
  );

  const renderInactive = () => (
    <FlatList
      data={inactiveRequests}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <RequestCard
          request={item}
          onAccept={() => undefined}
          onPass={() => undefined}
        />
      )}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      refreshControl={refresh.control}
      ListEmptyComponent={
        <View style={styles.emptyState}>
          <View style={styles.emptyIconCircle}>
            <UserX size={24} color={colors.mutedForeground} />
          </View>
          <Text style={styles.emptyTitle}>No inactive requests</Text>
          <Text style={styles.emptySubtext}>
            Requests you pass on will appear here.
          </Text>
        </View>
      }
    />
  );

  const screenContent = (
    <View style={styles.pageWrap}>
      {/* Page header */}
      <View style={styles.headerBlock}>
        <PageHeader
          title="Members"
          subtitle="Your caseload and incoming requests"
        />

        {/* ── Primary tab strip: My Members · Pending Requests · Inactive ── */}
        <View style={styles.tabStrip}>
          <TouchableOpacity
            style={[styles.tabItem, activeTab === 'my_members' && styles.tabItemActive]}
            onPress={() => setActiveTab('my_members')}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'my_members' }}
          >
            <Users size={14} color={activeTab === 'my_members' ? '#065F46' : '#6B7280'} />
            <Text style={[styles.tabText, activeTab === 'my_members' && styles.tabTextActive]}>
              My Members
            </Text>
            {acceptedRequests.length > 0 && (
              <View style={[styles.tabBadge, activeTab === 'my_members' && styles.tabBadgeActive]}>
                <Text style={[styles.tabBadgeText, activeTab === 'my_members' && styles.tabBadgeTextActive]}>
                  {acceptedRequests.length}
                </Text>
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabItem, activeTab === 'pending_requests' && styles.tabItemActive]}
            onPress={() => setActiveTab('pending_requests')}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'pending_requests' }}
          >
            <Inbox size={14} color={activeTab === 'pending_requests' ? '#065F46' : '#6B7280'} />
            <Text style={[styles.tabText, activeTab === 'pending_requests' && styles.tabTextActive]}>
              Pending Requests
            </Text>
            {allOpenRequests.length > 0 && (
              <View style={[styles.tabBadge, activeTab === 'pending_requests' && styles.tabBadgeActive]}>
                <Text style={[styles.tabBadgeText, activeTab === 'pending_requests' && styles.tabBadgeTextActive]}>
                  {allOpenRequests.length}
                </Text>
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabItem, activeTab === 'inactive' && styles.tabItemActive]}
            onPress={() => setActiveTab('inactive')}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'inactive' }}
          >
            <UserX size={14} color={activeTab === 'inactive' ? '#065F46' : '#6B7280'} />
            <Text style={[styles.tabText, activeTab === 'inactive' && styles.tabTextActive]}>
              Inactive
            </Text>
            {inactiveRequests.length > 0 && (
              <View style={[styles.tabBadge, activeTab === 'inactive' && styles.tabBadgeActive]}>
                <Text style={[styles.tabBadgeText, activeTab === 'inactive' && styles.tabBadgeTextActive]}>
                  {inactiveRequests.length}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Tab body ── */}
      {activeTab === 'my_members' && renderMyMembers()}
      {activeTab === 'pending_requests' && renderPendingRequests()}
      {activeTab === 'inactive' && renderInactive()}
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppShell
        role="chw"
        activeKey="members"
        userBlock={{ initials, name: userName ?? 'CHW', role: 'CHW' }}
      >
        {screenContent}
      </AppShell>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: tokens.pageBg,
  } as ViewStyle,
  pageWrap: {
    flex: 1,
    width: '100%',
    maxWidth: 1100,
    alignSelf: 'center',
  } as ViewStyle,
  headerBlock: {
    paddingHorizontal: 32,
    paddingTop: 32,
    paddingBottom: 0,
    backgroundColor: tokens.pageBg,
  } as ViewStyle,
  pageTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#1E3320',
  } as TextStyle,

  // ── Primary tab strip — mockup filter-btn: py-7px px-14px, radius 10, border, 13px 500
  tabStrip: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 20,
    flexWrap: 'wrap',
  } as ViewStyle,
  tabItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  } as ViewStyle,
  tabItemActive: {
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
  } as ViewStyle,
  tabText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#6B7280',
  } as TextStyle,
  tabTextActive: {
    color: '#065F46',
  } as TextStyle,
  tabBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  } as ViewStyle,
  tabBadgeActive: {
    backgroundColor: '#6EE7B7',
  } as ViewStyle,
  tabBadgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#6B7280',
  } as TextStyle,
  tabBadgeTextActive: {
    color: '#065F46',
  } as TextStyle,

  // ── Vertical filter chips (Pending tab only) — matches mockup filter-btn style
  filterChipsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 16,
    paddingHorizontal: 32,
  } as ViewStyle,
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  } as ViewStyle,
  filterChipActive: {
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
  } as ViewStyle,
  filterChipText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#6B7280',
  } as TextStyle,
  filterChipTextActive: {
    color: '#065F46',
  } as TextStyle,

  // ── Summary stat row (Pending tab)
  statSummaryRow: {
    flexDirection: 'row',
    gap: 16,
    marginBottom: 16,
    paddingHorizontal: 32,
    paddingTop: 8,
  } as ViewStyle,
  statSummaryCard: {
    flex: 1,
    padding: 12,
    alignItems: 'center',
    gap: 4,
  } as ViewStyle,
  statSummaryIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  } as ViewStyle,
  statSummaryValue: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    color: '#1E3320',
    lineHeight: 30,
  } as TextStyle,
  statSummaryLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
  } as TextStyle,

  // ── List — outer padding matches mockup's main p-8
  listContent: {
    paddingHorizontal: 32,
    paddingTop: 0,
    paddingBottom: 48,
  } as ViewStyle,

  // ── Empty state
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    gap: 12,
  } as ViewStyle,
  emptyIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#3D5A3E15',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  emptyTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
  } as TextStyle,
  emptySubtext: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    textAlign: 'center',
    maxWidth: 280,
  } as TextStyle,
});

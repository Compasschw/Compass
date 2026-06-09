/**
 * CHWMembersScreen — Roster of all members the CHW has a relationship with.
 *
 * Layout (web, matching native/_mockups/members.html):
 *   - AppShell with role="chw" / activeKey="members"
 *   - Header: "My Members" + subtitle (active count · inactive count · refreshed N mins ago)
 *     Right side: search input (288px, magnifying-glass leading icon) + "Add Member" button
 *   - Filter chips row: All / Active / High Risk / Overdue follow-up / In a journey / Inactive
 *     Right-aligned: filter icon + "Sort: Last contact ↓"
 *   - Table card (rounded-16, white, bordered):
 *       THEAD: #F9FAFB bg, 11px/600/uppercase/#6B7280, padding 10×16, border-bottom #F3F4F6
 *       Columns: Member · Status · Risk · Engagement · Active Journey · Last Contact · Top Need · (chevron)
 *       TBODY rows: padding 14×16, border-bottom #F3F4F6, hover #F9FAFB, cursor pointer
 *   - Pagination footer: "Showing N of M members" + page buttons (static v1)
 *
 * On native: simplified card list (table layout doesn't suit small screens).
 *
 * Data: useChwMembers() from GET /api/v1/chw/members.
 */

import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { DrawerNavigationProp } from '@react-navigation/drawer';
import {
  ChevronRight,
  ChevronLeft,
  Check,
  Filter,
  Search,
  UserPlus,
  Users,
  X,
} from 'lucide-react-native';

import { AppShell, Card, PageHeader, Pill } from '../../components/ui';
import type { PillVariant } from '../../components/ui/Pill';
import { Avatar } from '../../components/shared/Avatar';
import { colors, radius, spacing } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';
import {
  useChwMembers,
  useIncomingMemberRequests,
  useAcceptRequest,
  usePassRequest,
  type MembersRosterItem,
  type IncomingMemberRequest,
} from '../../hooks/useApiQueries';
import type { CHWTabParamList } from '../../navigation/CHWTabNavigator';

// ─── Types ────────────────────────────────────────────────────────────────────

type FilterKey = 'all' | 'active' | 'inactive' | 'request';

interface FilterChip {
  key: FilterKey;
  label: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Number of days without contact before a member is flagged "Overdue". */
const OVERDUE_THRESHOLD_DAYS = 5;

/**
 * Four canonical filter chips for the member roster.
 * - All: entire relationship roster
 * - Active: members with status === 'active'
 * - Inactive: members with status === 'inactive'
 * - Request: pending Schedule-with-Me requests within their 24h CHW-exclusive
 *   window. Backed by GET /requests/incoming + useIncomingMemberRequests.
 *   Renders a different row layout (inline Accept/Decline) because each entry
 *   is a prospective member, not an established one.
 */
const FILTER_CHIPS: FilterChip[] = [
  { key: 'all',      label: 'All'      },
  { key: 'active',   label: 'Active'   },
  { key: 'inactive', label: 'Inactive' },
  { key: 'request',  label: 'Request'  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a human-readable relative timestamp string.
 * E.g. "today", "2 days ago", "3 weeks ago".
 */
function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return '—';
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 5) return `${diffWeeks} week${diffWeeks > 1 ? 's' : ''} ago`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths} month${diffMonths > 1 ? 's' : ''} ago`;
}

/**
 * Returns a short formatted date string, e.g. "May 9".
 */
function formatShortDate(isoString: string | null): string {
  if (!isoString) return '';
  return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Returns true when a member's last contact is more than OVERDUE_THRESHOLD_DAYS
 * days ago (or they have never been contacted).
 */
function isOverdue(lastContactAt: string | null): boolean {
  if (!lastContactAt) return true;
  const diffMs = Date.now() - new Date(lastContactAt).getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays > OVERDUE_THRESHOLD_DAYS;
}

/**
 * Maps risk level to Pill variant. Returns null when risk is null (pill hidden).
 * Accepts the loosened string type to remain forward-compatible once a risk
 * model is wired up and the backend starts returning non-null values.
 */
function riskVariant(risk: string | null): 'emerald' | 'amber-dark' | 'red' | null {
  switch (risk) {
    case 'low':    return 'emerald';
    case 'medium': return 'amber-dark';
    case 'high':   return 'red';
    default:       return null;
  }
}

/**
 * Maps risk level to display label.
 */
function riskLabel(risk: string | null): string {
  switch (risk) {
    case 'low':    return 'Low';
    case 'medium': return 'Medium';
    case 'high':   return 'High';
    default:       return '';
  }
}

/**
 * Maps engagement level → Pill variant.
 * When the member is inactive, "disengaged" renders as gray-muted (gray-100/gray-600).
 */
function engagementVariant(
  engagement: MembersRosterItem['engagement'],
  status: MembersRosterItem['status'],
): 'emerald' | 'amber-dark' | 'red' | 'gray-muted' {
  switch (engagement) {
    case 'highly':      return 'emerald';
    case 'moderately':  return 'amber-dark';
    case 'disengaged':
      return status === 'inactive' ? 'gray-muted' : 'red';
  }
}

/**
 * Maps engagement → display label.
 */
function engagementLabel(engagement: MembersRosterItem['engagement']): string {
  switch (engagement) {
    case 'highly':      return 'Highly Engaged';
    case 'moderately':  return 'Moderately Engaged';
    case 'disengaged':  return 'Disengaged';
  }
}

/**
 * Maps a vertical slug to a Pill variant for the Top Need cell.
 */
function verticalVariant(
  vertical: string | null,
): 'red' | 'orange' | 'purple' | 'amber' | 'pink' | 'emerald' | 'blue' | 'gray' {
  if (!vertical) return 'gray';
  const map: Record<string, 'red' | 'orange' | 'purple' | 'amber' | 'pink' | 'emerald' | 'blue' | 'gray'> = {
    housing:         'red',
    food:            'orange',
    mental_health:   'purple',
    transportation:  'amber',
    maternal_health: 'pink',
    healthcare:      'emerald',
    benefits:        'blue',
    utilities:       'emerald',
  };
  return map[vertical.toLowerCase()] ?? 'gray';
}

/**
 * Capitalises and formats a vertical slug for display, e.g. "mental_health" → "Mental Health".
 */
function formatVertical(vertical: string | null): string {
  if (!vertical) return '—';
  return vertical
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ─── Avatar circle ────────────────────────────────────────────────────────────
//
// Local AvatarCircle removed in favor of the shared `Avatar` component
// (`components/shared/Avatar.tsx`), which now hosts the deterministic
// per-person color palette. Pass `displayName` for the color seed and an
// optional `initials` override matching the backend-supplied value.

// ─── Request row (Schedule-with-Me pending requests) ────────────────────────
//
// One row per pending incoming request. Layout mirrors the standard member
// table row (avatar + name on the left, status pill + extra metadata in the
// middle, action column on the right) so the visual rhythm matches the rest
// of the table.  Differences vs MemberTableRow:
//   - Status pill says "Pending request" (yellow) instead of Active/Inactive
//   - Engagement column shows the urgency chip (Routine / Soon / Urgent)
//   - Last-contact column shows time-since-submitted + 24h-window countdown
//   - Trailing chevron slot replaced with Accept (green) / Decline (red) buttons

interface RequestRowProps {
  request: IncomingMemberRequest;
  onAccept: () => void;
  onDecline: () => void;
  disabled: boolean;
}

function RequestRow({ request, onAccept, onDecline, disabled }: RequestRowProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);

  // Human-readable "submitted N minutes/hours ago".
  const createdAgo = useMemo(() => {
    const diffMs = Date.now() - new Date(request.createdAt).getTime();
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
    return 'over a day ago';
  }, [request.createdAt]);

  // Urgency → visual variant. Matches the chip colors used in MemberFindScreen.
  const urgencyTone = request.urgency === 'urgent'
    ? 'red'
    : request.urgency === 'soon'
      ? 'amber'
      : 'gray';

  const verticalsLabel = request.verticals.length > 0
    ? request.verticals.map((v) => v.replace(/_/g, ' ')).join(', ')
    : request.vertical.replace(/_/g, ' ');

  const urgencyPill: PillVariant = urgencyTone === 'red'
    ? 'red'
    : urgencyTone === 'amber'
      ? 'amber'
      : 'gray';

  // Native: fall back to a card-style row.  Web: full table layout.
  if (Platform.OS !== 'web') {
    return (
      <View style={styles.requestNativeCard}>
        <View style={styles.requestNativeHeader}>
          <Avatar displayName={request.memberName} size={36} />
          <View style={{ flex: 1 }}>
            <Text style={cardStyles.name}>{request.memberName}</Text>
            <Text style={styles.requestSubText}>{verticalsLabel} · {createdAgo}</Text>
          </View>
        </View>
        <View style={styles.requestActionsRow}>
          <TouchableOpacity
            style={[styles.declineBtn, disabled && styles.disabledBtn]}
            onPress={onDecline}
            disabled={disabled}
          >
            <X size={14} color="#fff" />
            <Text style={styles.acceptDeclineText}>Decline</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.acceptBtn, disabled && styles.disabledBtn]}
            onPress={onAccept}
            disabled={disabled}
          >
            <Check size={14} color="#fff" />
            <Text style={styles.acceptDeclineText}>Accept</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[rowStyles.row, hovered && rowStyles.rowHover]}
      // @ts-ignore — web-only pointer events
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Member column */}
      <View style={[rowStyles.cell, rowStyles.memberCell]}>
        <Avatar displayName={request.memberName} size={36} />
        <View style={rowStyles.memberInfo}>
          <Text style={rowStyles.memberName}>{request.memberName}</Text>
          <Text style={rowStyles.memberMeta}>{verticalsLabel}</Text>
        </View>
      </View>

      {/* Status — Pending request pill */}
      <View style={rowStyles.cell}>
        <Pill variant="amber" size="sm" withDot>Pending request</Pill>
      </View>

      {/* Risk column placeholder — kept blank for prospective members. */}
      <View style={rowStyles.cell}>
        <Text style={rowStyles.noJourney}>—</Text>
      </View>

      {/* Engagement column → urgency chip */}
      <View style={rowStyles.cell}>
        <Pill variant={urgencyPill} size="sm">
          {request.urgency.charAt(0).toUpperCase() + request.urgency.slice(1)}
        </Pill>
      </View>

      {/* Active Journey column placeholder. */}
      <View style={rowStyles.cell}>
        <Text style={rowStyles.noJourney}>—</Text>
      </View>

      {/* Last Contact column → "submitted N min ago" */}
      <View style={rowStyles.cell}>
        <Text style={rowStyles.lastContact}>{createdAgo}</Text>
      </View>

      {/* Top Need column → preferred-mode label so the CHW knows what was asked. */}
      <View style={rowStyles.cell}>
        <Text style={rowStyles.memberMeta}>
          {request.preferredMode === 'in_person' ? 'In Person'
            : request.preferredMode === 'virtual' ? 'Virtual'
              : 'Phone'}
        </Text>
      </View>

      {/* Action column — Accept / Decline buttons replace the chevron */}
      <View style={[rowStyles.cell, { flex: 0, width: 200, gap: 6, flexDirection: 'row', justifyContent: 'flex-end' }]}>
        <TouchableOpacity
          style={[styles.declineBtn, disabled && styles.disabledBtn]}
          onPress={onDecline}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`Decline request from ${request.memberName}`}
        >
          <X size={14} color="#fff" />
          <Text style={styles.acceptDeclineText}>Decline</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.acceptBtn, disabled && styles.disabledBtn]}
          onPress={onAccept}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`Accept request from ${request.memberName}`}
        >
          <Check size={14} color="#fff" />
          <Text style={styles.acceptDeclineText}>Accept</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Table row (web) ──────────────────────────────────────────────────────────

interface RowProps {
  item: MembersRosterItem;
  onPress: () => void;
}

function MemberTableRow({ item, onPress }: RowProps): React.JSX.Element {
  const overdue = isOverdue(item.lastContactAt);
  const [hovered, setHovered] = useState(false);

  const risk = riskVariant(item.risk);

  return (
    <TouchableOpacity
      style={[rowStyles.row, hovered && rowStyles.rowHover]}
      onPress={onPress}
      // @ts-ignore — web-only pointer events
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`View profile for ${item.displayName}`}
    >
      {/* Member column */}
      <View style={[rowStyles.cell, rowStyles.memberCell]}>
        <Avatar
          displayName={item.displayName}
          initials={item.avatarInitials}
          size={36}
        />
        <View style={rowStyles.memberInfo}>
          <Text style={rowStyles.memberName}>{item.displayName}</Text>
          <Text style={rowStyles.memberMeta}>
            {item.age != null ? `${item.age} · ` : ''}ID {item.maskedId}
          </Text>
        </View>
      </View>

      {/* Status — dot indicator + Active/Inactive */}
      <View style={rowStyles.cell}>
        <Pill
          variant={item.status === 'active' ? 'emerald' : 'gray'}
          size="sm"
          withDot
        >
          {item.status === 'active' ? 'Active' : 'Inactive'}
        </Pill>
      </View>

      {/* Risk — hidden when null */}
      <View style={rowStyles.cell}>
        {risk != null && (
          <Pill variant={risk} size="sm" withDot>
            {riskLabel(item.risk)}
          </Pill>
        )}
      </View>

      {/* Engagement */}
      <View style={rowStyles.cell}>
        <Pill variant={engagementVariant(item.engagement, item.status)} size="sm">
          {engagementLabel(item.engagement)}
        </Pill>
      </View>

      {/* Active Journey */}
      <View style={rowStyles.cell}>
        {item.activeJourney != null ? (
          <View>
            <Text style={rowStyles.journeyName}>{item.activeJourney.name}</Text>
            <Text style={rowStyles.journeyMeta}>
              {Math.round(item.activeJourney.percent)}%
              {item.activeJourney.currentStep ? ` · ${item.activeJourney.currentStep}` : ''}
            </Text>
          </View>
        ) : (
          <Text style={rowStyles.noJourney}>No active journey</Text>
        )}
      </View>

      {/* Last Contact */}
      <View style={rowStyles.cell}>
        <Text style={rowStyles.lastContact}>{formatRelativeTime(item.lastContactAt)}</Text>
        {overdue && item.status === 'active' ? (
          <Text style={rowStyles.overdueLabel}>Overdue</Text>
        ) : item.status === 'inactive' ? (
          <Text style={rowStyles.overdueLabel}>Re-engage</Text>
        ) : (
          <Text style={rowStyles.lastContactDate}>{formatShortDate(item.lastContactAt)}</Text>
        )}
      </View>

      {/* Top Need */}
      <View style={rowStyles.cell}>
        {item.topNeed != null ? (
          <Pill variant={verticalVariant(item.topNeed)} size="sm">
            {formatVertical(item.topNeed)}
          </Pill>
        ) : (
          <Text style={rowStyles.noJourney}>—</Text>
        )}
      </View>

      {/* Chevron */}
      <View style={[rowStyles.cell, rowStyles.chevronCell]}>
        <ChevronRight size={16} color="#D1D5DB" />
      </View>
    </TouchableOpacity>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection:   'row',
    alignItems:      'center',
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    // @ts-ignore — web-only
    cursor: 'pointer',
  } as ViewStyle,

  rowHover: {
    backgroundColor: '#F9FAFB',
  } as ViewStyle,

  cell: {
    paddingHorizontal: 16,
    paddingVertical:   14,
    flex:              1,
    flexShrink:        0,
  } as ViewStyle,

  memberCell: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           12,
    flex:          2,
  } as ViewStyle,

  memberInfo: {
    gap:      2,
    flexShrink: 1,
  } as ViewStyle,

  memberName: {
    fontSize:   14,
    fontWeight: '600',
    color:      '#111827',
  } as TextStyle,

  memberMeta: {
    fontSize: 12,
    color:    '#6B7280',
  } as TextStyle,

  journeyName: {
    fontSize:   14,
    fontWeight: '500',
    color:      '#374151',
  } as TextStyle,

  journeyMeta: {
    fontSize:  12,
    color:     '#6B7280',
    marginTop: 1,
  } as TextStyle,

  noJourney: {
    fontSize: 14,
    color:    '#9CA3AF',
  } as TextStyle,

  lastContact: {
    fontSize: 14,
    color:    '#374151',
  } as TextStyle,

  lastContactDate: {
    fontSize:  11,
    color:     '#6B7280',
    marginTop: 1,
  } as TextStyle,

  overdueLabel: {
    fontSize:   11,
    fontWeight: '600',
    color:      '#EF4444',
    marginTop:  1,
  } as TextStyle,

  chevronCell: {
    flex:         0,
    width:        48,
    alignItems:   'flex-end',
    paddingRight: 16,
  } as ViewStyle,
});

// ─── Native card (mobile) ─────────────────────────────────────────────────────

interface MemberCardProps {
  item: MembersRosterItem;
  onPress: () => void;
}

function MemberCard({ item, onPress }: MemberCardProps): React.JSX.Element {
  const overdue = isOverdue(item.lastContactAt);

  return (
    <TouchableOpacity
      onPress={onPress}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`View profile for ${item.displayName}`}
    >
      <Card style={cardStyles.card}>
        <View style={cardStyles.headerRow}>
          <Avatar
            displayName={item.displayName}
            initials={item.avatarInitials}
            size={40}
          />
          <View style={cardStyles.nameBlock}>
            <Text style={cardStyles.name}>{item.displayName}</Text>
            <Text style={cardStyles.meta}>
              {item.age != null ? `${item.age} · ` : ''}ID {item.maskedId}
            </Text>
          </View>
          <ChevronRight size={18} color={colors.textMuted} />
        </View>

        <View style={cardStyles.pillRow}>
          <Pill variant={item.status === 'active' ? 'emerald' : 'gray'} size="sm" withDot>
            {item.status === 'active' ? 'Active' : 'Inactive'}
          </Pill>
          <Pill variant={engagementVariant(item.engagement, item.status)} size="sm">
            {engagementLabel(item.engagement)}
          </Pill>
          {item.topNeed != null && (
            <Pill variant={verticalVariant(item.topNeed)} size="sm">
              {formatVertical(item.topNeed)}
            </Pill>
          )}
        </View>

        {item.activeJourney != null && (
          <Text style={cardStyles.journeyLine}>
            Journey: {item.activeJourney.name} · {Math.round(item.activeJourney.percent)}%
          </Text>
        )}

        <View style={cardStyles.contactRow}>
          <Text style={cardStyles.contactTime}>
            Last contact: {formatRelativeTime(item.lastContactAt)}
          </Text>
          {overdue && item.status === 'active' && (
            <Text style={cardStyles.overdueTag}>Overdue</Text>
          )}
        </View>
      </Card>
    </TouchableOpacity>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    padding:      spacing.lg,
    gap:          spacing.sm,
    marginBottom: spacing.sm,
  } as ViewStyle,

  headerRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
  } as ViewStyle,

  nameBlock: {
    flex: 1,
    gap:  2,
  } as ViewStyle,

  name: {
    fontSize:   15,
    fontWeight: '600',
    color:      colors.textPrimary,
  } as TextStyle,

  meta: {
    fontSize: 12,
    color:    colors.textSecondary,
  } as TextStyle,

  pillRow: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           spacing.xs,
    marginTop:     spacing.xs,
  } as ViewStyle,

  journeyLine: {
    fontSize:  12,
    color:     colors.textSecondary,
    marginTop: spacing.xs,
  } as TextStyle,

  contactRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
    marginTop:     spacing.xs,
  } as ViewStyle,

  contactTime: {
    fontSize: 12,
    color:    colors.textSecondary,
    flex:     1,
  } as TextStyle,

  overdueTag: {
    fontSize:   11,
    fontWeight: '700',
    color:      colors.red700,
  } as TextStyle,
});

// ─── Pagination button (web) ──────────────────────────────────────────────────

interface PageButtonProps {
  label: string;
  active?: boolean;
  icon?: 'prev' | 'next';
}

function PageButton({ label, active = false, icon }: PageButtonProps): React.JSX.Element {
  return (
    <View
      style={[
        pageStyles.btn,
        active ? pageStyles.btnActive : pageStyles.btnDefault,
      ]}
    >
      {icon === 'prev' ? (
        <ChevronLeft size={14} color={active ? '#fff' : '#374151'} />
      ) : icon === 'next' ? (
        <ChevronRight size={14} color={active ? '#fff' : '#374151'} />
      ) : (
        <Text style={[pageStyles.btnText, active && pageStyles.btnTextActive]}>
          {label}
        </Text>
      )}
    </View>
  );
}

const pageStyles = StyleSheet.create({
  btn: {
    minWidth:        32,
    height:          32,
    borderRadius:    8,
    alignItems:      'center',
    justifyContent:  'center',
    paddingHorizontal: 10,
  } as ViewStyle,

  btnDefault: {
    borderWidth:  1,
    borderColor:  '#E5E7EB',
    backgroundColor: '#fff',
  } as ViewStyle,

  btnActive: {
    backgroundColor: '#059669', // emerald-600
  } as ViewStyle,

  btnText: {
    fontSize:   13,
    fontWeight: '500',
    color:      '#374151',
  } as TextStyle,

  btnTextActive: {
    color:      '#fff',
    fontWeight: '600',
  } as TextStyle,
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CHWMembersScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const navigation = useNavigation<DrawerNavigationProp<CHWTabParamList>>();
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const { data: members = [], isLoading, isError, dataUpdatedAt } = useChwMembers();

  // Incoming Schedule-with-X member requests (24h CHW-exclusive window).
  // Always fetch — the chip count needs the array length even when the
  // user is on a different filter.
  const { data: incomingRequests = [] } = useIncomingMemberRequests();
  const acceptRequest = useAcceptRequest();
  const passRequest = usePassRequest();

  // ── Derived counts ───────────────────────────────────────────────────────────
  const activeCount = useMemo(
    () => members.filter((m) => m.status === 'active').length,
    [members],
  );
  const inactiveCount = useMemo(
    () => members.filter((m) => m.status === 'inactive').length,
    [members],
  );
  const lastRefreshedLabel = useMemo(() => {
    if (!dataUpdatedAt) return '';
    const diffMs = Date.now() - dataUpdatedAt;
    const diffMins = Math.round(diffMs / 60_000);
    if (diffMins < 1) return 'just now';
    return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  }, [dataUpdatedAt]);

  // ── Filter + search ──────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let result = members;

    switch (activeFilter) {
      case 'active':
        result = result.filter((m) => m.status === 'active');
        break;
      case 'inactive':
        result = result.filter((m) => m.status === 'inactive');
        break;
      // 'all' and 'request' require no member-list filtering; 'request'
      // renders the incomingRequests list separately and never reaches here.
      default:
        break;
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (m) =>
          m.displayName.toLowerCase().includes(q) ||
          m.maskedId.toLowerCase().includes(q),
      );
    }

    return result;
  }, [members, activeFilter, searchQuery]);

  // ── User initials for AppShell user block ────────────────────────────────────
  const userInitials = (userName ?? 'CHW')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  // ── Navigation ───────────────────────────────────────────────────────────────
  const handleMemberPress = (memberId: string) => {
    (navigation as any).navigate('SessionsStack', {
      screen: 'MemberProfile',
      params: { memberId },
    });
  };

  // ── Count helper for chip labels ─────────────────────────────────────────────
  const chipCount = (key: FilterKey): number => {
    switch (key) {
      case 'all':      return members.length;
      case 'active':   return activeCount;
      case 'inactive': return inactiveCount;
      case 'request':  return incomingRequests.length;
    }
  };

  // ── Shared content ───────────────────────────────────────────────────────────
  const content = (
    <>
      {/* ── Header row ────────────────────────────────────────────────────── */}
      <View style={styles.headerRow}>
        <View>
          <PageHeader title="My Members" />
          <Text style={styles.subtitle}>
            {activeCount} active · {inactiveCount} inactive
            {lastRefreshedLabel ? ` · last refreshed ${lastRefreshedLabel}` : ''}
          </Text>
        </View>

        {/* Search + Add Member */}
        <View style={styles.headerActions}>
          <View style={styles.searchWrap}>
            <Search size={16} color="#9CA3AF" style={styles.searchIcon as any} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search by name, ID, phone..."
              placeholderTextColor="#9CA3AF"
              value={searchQuery}
              onChangeText={setSearchQuery}
              accessible
              accessibilityLabel="Search members"
            />
          </View>
          <TouchableOpacity
            style={styles.addButton}
            accessible
            accessibilityRole="button"
            accessibilityLabel="Add member"
          >
            <UserPlus size={16} color="#fff" />
            <Text style={styles.addButtonText}>Add Member</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Filter chips row ─────────────────────────────────────────────── */}
      <View style={styles.filterRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterChipsContent}
        >
          {FILTER_CHIPS.map((chip) => {
            const isActive = activeFilter === chip.key;
            const count = chipCount(chip.key);
            return (
              <TouchableOpacity
                key={chip.key}
                onPress={() => setActiveFilter(chip.key)}
                style={[styles.filterChip, isActive && styles.filterChipActive]}
                accessible
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
                accessibilityLabel={`Filter: ${chip.label} (${count})`}
              >
                <Text style={[styles.filterChipText, isActive && styles.filterChipTextActive]}>
                  {chip.label} ({count})
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Sort label — right-aligned, web only looks best as absolute but flex works */}
        <View style={styles.sortLabel}>
          <Filter size={14} color="#6B7280" />
          <Text style={styles.sortText}>Sort: Last contact ↓</Text>
        </View>
      </View>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      {activeFilter === 'request' ? (
        /* Request filter — pending Schedule-with-Me requests. Different row
           shape than the standard members table: each row is a prospective
           member with inline Accept/Decline buttons.  Uses the same Card
           container so the visual rhythm matches the other filters. */
        incomingRequests.length === 0 ? (
          <Card style={styles.emptyCard}>
            <Users size={32} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No pending requests</Text>
            <Text style={styles.emptyText}>
              When a member schedules a session with you from their My CHW
              screen, the request will appear here for the first 24 hours.
            </Text>
          </Card>
        ) : (
          <Card style={styles.tableCard}>
            {incomingRequests.map((req) => (
              <RequestRow
                key={req.id}
                request={req}
                onAccept={() => acceptRequest.mutate(req.id)}
                onDecline={() => passRequest.mutate(req.id)}
                disabled={acceptRequest.isPending || passRequest.isPending}
              />
            ))}
          </Card>
        )
      ) : isLoading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading members…</Text>
        </View>
      ) : isError ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyText}>
            Unable to load members. Pull down to retry.
          </Text>
        </Card>
      ) : filtered.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Users size={32} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No members found</Text>
          <Text style={styles.emptyText}>
            {searchQuery
              ? 'Try a different search term.'
              : activeFilter === 'all'
                ? 'Members will appear here once you accept a request or complete a session.'
                : 'No members match this filter.'}
          </Text>
        </Card>
      ) : Platform.OS === 'web' ? (
        /* Web: full table layout */
        <Card style={styles.tableCard}>
          {/* Table header */}
          <View style={styles.tableHead}>
            {(
              [
                { label: 'Member',         flex: 2 },
                { label: 'Status',         flex: 1 },
                { label: 'Risk',           flex: 1 },
                { label: 'Engagement',     flex: 1 },
                { label: 'Active Journey', flex: 1 },
                { label: 'Last Contact',   flex: 1 },
                { label: 'Top Need',       flex: 1 },
                { label: '',               flex: 0, width: 48 },
              ] as const
            ).map((col) => (
              <View
                key={col.label}
                style={[
                  styles.headCell,
                  { flex: col.flex },
                  'width' in col ? { flex: 0, width: col.width } : undefined,
                ]}
              >
                <Text style={styles.headText}>{col.label}</Text>
              </View>
            ))}
          </View>

          {/* Table body */}
          {filtered.map((item) => (
            <MemberTableRow
              key={item.id}
              item={item}
              onPress={() => handleMemberPress(item.id)}
            />
          ))}
        </Card>
      ) : (
        /* Native: card list */
        <View style={styles.cardList}>
          {filtered.map((item) => (
            <MemberCard
              key={item.id}
              item={item}
              onPress={() => handleMemberPress(item.id)}
            />
          ))}
        </View>
      )}

      {/* ── Pagination footer (web, static v1) ───────────────────────────── */}
      {Platform.OS === 'web' && !isLoading && filtered.length > 0 && (
        <View style={styles.paginationRow}>
          <Text style={styles.paginationInfo}>
            Showing {filtered.length} of {members.length} member{members.length !== 1 ? 's' : ''}
          </Text>
          <View style={styles.paginationButtons}>
            <PageButton label="‹" icon="prev" />
            <PageButton label="1" active />
            <PageButton label="2" />
            <PageButton label="3" />
            <PageButton label="›" icon="next" />
          </View>
        </View>
      )}
    </>
  );

  // ── Platform shell ─────────────────────────────────────────────────────────
  if (Platform.OS !== 'web') {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <ScrollView
          contentContainerStyle={styles.nativeScroll}
          showsVerticalScrollIndicator={false}
        >
          {content}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <AppShell
      role="chw"
      activeKey="members"
      userBlock={{ initials: userInitials, name: userName ?? 'CHW', role: 'CHW' }}
    >
      {content}
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex:            1,
    backgroundColor: colors.pageBg,
  } as ViewStyle,

  nativeScroll: {
    padding:  spacing.lg,
    flexGrow: 1,
  } as ViewStyle,

  // ── Header ──────────────────────────────────────────────────────────────────

  headerRow: {
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
    alignItems:    Platform.OS === 'web' ? 'flex-end' : 'flex-start',
    justifyContent: 'space-between',
    marginBottom:  spacing.xl,
    gap:           spacing.md,
  } as ViewStyle,

  subtitle: {
    fontSize: 14,
    color:    '#6B7280',
    marginTop: 4,
  } as TextStyle,

  headerActions: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
    flexShrink:    1,
  } as ViewStyle,

  searchWrap: {
    flexDirection:   'row',
    alignItems:      'center',
    borderWidth:     1,
    borderColor:     '#E5E7EB',
    borderRadius:    radius.lg,
    paddingLeft:     10,
    paddingRight:    spacing.md,
    backgroundColor: '#fff',
    height:          38,
    width:           Platform.OS === 'web' ? 288 : undefined,
    flex:            Platform.OS === 'web' ? undefined : 1,
    gap:             6,
  } as ViewStyle,

  searchIcon: {} as ViewStyle,

  searchInput: {
    flex:     1,
    fontSize: 14,
    color:    colors.textPrimary,
    height:   '100%',
    // @ts-ignore — outline not in RN types but needed on web
    outlineStyle: 'none',
  } as TextStyle,

  addButton: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             spacing.xs,
    backgroundColor: '#10B981', // emerald-500 (#10B981) per mock
    borderRadius:    radius.lg,
    paddingHorizontal: 16,
    paddingVertical:   8,
    flexShrink:      0,
  } as ViewStyle,

  addButtonText: {
    fontSize:   14,
    fontWeight: '600',
    color:      '#fff',
  } as TextStyle,

  // ── Filter chips row ─────────────────────────────────────────────────────────

  filterRow: {
    flexDirection:  'row',
    alignItems:     'center',
    marginBottom:   spacing.lg,
    gap:            spacing.sm,
  } as ViewStyle,

  filterChipsContent: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
  } as ViewStyle,

  filterChip: {
    paddingHorizontal: 14,
    paddingVertical:   7,
    borderRadius:      10,
    borderWidth:       1,
    borderColor:       '#E5E7EB',
    backgroundColor:   '#fff',
  } as ViewStyle,

  filterChipActive: {
    backgroundColor: '#ECFDF5',
    borderColor:     '#A7F3D0',
  } as ViewStyle,

  filterChipText: {
    fontSize:   13,
    fontWeight: '500',
    color:      '#6B7280',
  } as TextStyle,

  filterChipTextActive: {
    color:      '#065F46',
    fontWeight: '600',
  } as TextStyle,

  sortLabel: {
    flexShrink:    0,
    flexDirection: 'row',
    alignItems:    'center',
    gap:           6,
    marginLeft:    'auto',
  } as ViewStyle,

  sortText: {
    fontSize: 14,
    color:    '#6B7280',
  } as TextStyle,

  // ── Table (web) ──────────────────────────────────────────────────────────────

  tableCard: {
    overflow: 'hidden',
    padding:  0,
  } as ViewStyle,

  tableHead: {
    flexDirection:     'row',
    backgroundColor:   '#F9FAFB',
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,

  headCell: {
    paddingHorizontal: 16,
    paddingVertical:   10,
    flexShrink:        0,
  } as ViewStyle,

  headText: {
    fontSize:      11,
    fontWeight:    '600',
    color:         '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.44, // 0.04em at 11px
  } as TextStyle,

  // ── Card list (native) ───────────────────────────────────────────────────────

  cardList: {
    gap: spacing.sm,
  } as ViewStyle,

  // ── States ───────────────────────────────────────────────────────────────────

  loadingWrap: {
    alignItems:     'center',
    justifyContent: 'center',
    gap:            spacing.md,
    paddingVertical: spacing.xxxl,
  } as ViewStyle,

  loadingText: {
    fontSize: 14,
    color:    colors.textSecondary,
  } as TextStyle,

  emptyCard: {
    padding:    spacing.xxl,
    alignItems: 'center',
    gap:        spacing.md,
  } as ViewStyle,

  emptyTitle: {
    fontSize:   16,
    fontWeight: '600',
    color:      colors.textPrimary,
  } as TextStyle,

  emptyText: {
    fontSize:   14,
    color:      colors.textSecondary,
    textAlign:  'center',
    maxWidth:   360,
  } as TextStyle,

  // ── Pagination ───────────────────────────────────────────────────────────────

  paginationRow: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'space-between',
    marginTop:       spacing.md,
  } as ViewStyle,

  paginationInfo: {
    fontSize: 14,
    color:    '#6B7280',
  } as TextStyle,

  paginationButtons: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
  } as ViewStyle,

  // ── Request filter: inline Accept/Decline buttons ──────────────────────────
  // Sized to fit comfortably in the trailing action slot on web (200px column).
  // Both use a flat color fill for a clear "primary action" feel; gray text
  // background on disabled to indicate in-flight mutations.
  acceptBtn: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
    paddingHorizontal: 12,
    paddingVertical:   8,
    borderRadius:  radius.sm,
    backgroundColor: '#16A34A',
  } as ViewStyle,
  declineBtn: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
    paddingHorizontal: 12,
    paddingVertical:   8,
    borderRadius:  radius.sm,
    backgroundColor: '#6B7280',
  } as ViewStyle,
  disabledBtn: {
    opacity: 0.5,
  } as ViewStyle,
  acceptDeclineText: {
    fontSize:   13,
    fontWeight: '600',
    color:      '#fff',
  } as TextStyle,
  dashText: {
    fontSize: 13,
    color:    colors.textMuted,
  } as TextStyle,

  // Native fallback card for request rows
  requestNativeCard: {
    backgroundColor: '#fff',
    padding: spacing.sm,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  requestNativeHeader: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           10,
  } as ViewStyle,
  requestSubText: {
    fontSize: 12,
    color:    colors.textSecondary,
  } as TextStyle,
  requestActionsRow: {
    flexDirection: 'row',
    gap:           8,
    justifyContent: 'flex-end',
  } as ViewStyle,
});

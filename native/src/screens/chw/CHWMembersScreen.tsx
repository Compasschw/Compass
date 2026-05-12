/**
 * CHWMembersScreen — Roster of all members the CHW has a relationship with.
 *
 * Layout (web, matching native/_mockups/members.html):
 *   - AppShell with role="chw" / activeKey="members"
 *   - Header: "My Members" + subtitle (active count · inactive count · refreshed N mins ago)
 *   - Filter chips: All / Active / High Risk / Overdue follow-up / In a journey / Inactive
 *   - Search input: filter by name, masked ID
 *   - Table: Member (avatar + name + age + masked ID) · Status · Risk · Engagement ·
 *             Active Journey · Last Contact · Top Need · chevron
 *   - Tap a row → navigate to CHWMemberProfileScreen
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
  Search,
  UserPlus,
  Users,
} from 'lucide-react-native';

import { AppShell, Card, PageHeader, Pill } from '../../components/ui';
import { colors, radius, spacing } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';
import {
  useChwMembers,
  type MembersRosterItem,
} from '../../hooks/useApiQueries';
import type { CHWTabParamList } from '../../navigation/CHWTabNavigator';

// ─── Types ────────────────────────────────────────────────────────────────────

type FilterKey = 'all' | 'active' | 'high_risk' | 'overdue' | 'in_journey' | 'inactive';

interface FilterChip {
  key: FilterKey;
  label: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Number of days without contact before a member is flagged "Overdue". */
const OVERDUE_THRESHOLD_DAYS = 5;

const FILTER_CHIPS: FilterChip[] = [
  { key: 'all',        label: 'All'              },
  { key: 'active',     label: 'Active'           },
  { key: 'high_risk',  label: 'High Risk'        },
  { key: 'overdue',    label: 'Overdue follow-up' },
  { key: 'in_journey', label: 'In a journey'     },
  { key: 'inactive',   label: 'Inactive'         },
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
 * Map engagement → Pill variant.
 */
function engagementVariant(engagement: MembersRosterItem['engagement']) {
  switch (engagement) {
    case 'highly':      return 'emerald' as const;
    case 'moderately':  return 'amber' as const;
    case 'disengaged':  return 'red' as const;
  }
}

/**
 * Map engagement → display label.
 */
function engagementLabel(engagement: MembersRosterItem['engagement']): string {
  switch (engagement) {
    case 'highly':      return 'Highly Engaged';
    case 'moderately':  return 'Moderately Engaged';
    case 'disengaged':  return 'Disengaged';
  }
}

/**
 * Map a vertical string to a Pill variant for the Top Need cell.
 */
function verticalVariant(vertical: string | null) {
  if (!vertical) return 'gray' as const;
  const map: Record<string, 'red' | 'orange' | 'purple' | 'amber' | 'pink' | 'emerald' | 'blue' | 'gray'> = {
    housing:        'red',
    food:           'orange',
    mental_health:  'purple',
    transportation: 'amber',
    maternal_health:'pink',
    healthcare:     'emerald',
    benefits:       'blue',
    utilities:      'emerald',
  };
  return map[vertical.toLowerCase()] ?? 'gray';
}

/**
 * Capitalize and format a vertical slug for display, e.g. "mental_health" → "Mental Health".
 */
function formatVertical(vertical: string | null): string {
  if (!vertical) return '—';
  return vertical
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ─── Avatar circle ────────────────────────────────────────────────────────────

/**
 * Deterministically picks a background colour for an avatar based on initials.
 * Uses a stable hash so the same person always gets the same colour.
 */
const AVATAR_COLORS: Array<{ bg: string; text: string }> = [
  { bg: colors.emerald100, text: colors.emerald700 },
  { bg: colors.blue100,    text: colors.blue700    },
  { bg: colors.purple100,  text: colors.purple700  },
  { bg: colors.amber100,   text: colors.amber700   },
  { bg: colors.pink100,    text: colors.pink700    },
  { bg: colors.cyan100,    text: colors.cyan700    },
  { bg: colors.indigo100,  text: colors.indigo700  },
  { bg: colors.rose100,    text: colors.rose700    },
];

function avatarColorFor(initials: string): { bg: string; text: string } {
  let hash = 0;
  for (let i = 0; i < initials.length; i++) {
    hash = (hash * 31 + initials.charCodeAt(i)) & 0xffffffff;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

interface AvatarProps {
  initials: string;
  size?: number;
}

function AvatarCircle({ initials, size = 36 }: AvatarProps): React.JSX.Element {
  const { bg, text } = avatarColorFor(initials);
  return (
    <View
      style={[
        avatarStyles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: bg },
      ]}
    >
      <Text style={[avatarStyles.initials, { color: text, fontSize: size * 0.35 }]}>
        {initials}
      </Text>
    </View>
  );
}

const avatarStyles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  initials: {
    fontWeight: '700',
    lineHeight: undefined,
  } as TextStyle,
});

// ─── Table row (web) ──────────────────────────────────────────────────────────

interface RowProps {
  item: MembersRosterItem;
  onPress: () => void;
}

function MemberTableRow({ item, onPress }: RowProps): React.JSX.Element {
  const overdue = isOverdue(item.lastContactAt);

  return (
    <TouchableOpacity
      style={rowStyles.row}
      onPress={onPress}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`View profile for ${item.displayName}`}
    >
      {/* Member column */}
      <View style={[rowStyles.cell, rowStyles.memberCell]}>
        <AvatarCircle initials={item.avatarInitials} />
        <View style={rowStyles.memberInfo}>
          <Text style={rowStyles.memberName}>{item.displayName}</Text>
          <Text style={rowStyles.memberMeta}>
            {item.age != null ? `${item.age} · ` : ''}ID {item.maskedId}
          </Text>
        </View>
      </View>

      {/* Status */}
      <View style={rowStyles.cell}>
        <Pill variant={item.status === 'active' ? 'emerald' : 'gray'} size="sm">
          {item.status === 'active' ? 'Active' : 'Inactive'}
        </Pill>
      </View>

      {/* Risk — hidden in v1 (always null) */}
      <View style={rowStyles.cell}>
        {item.risk != null && (
          <Pill variant="amber" size="sm">Unknown</Pill>
        )}
      </View>

      {/* Engagement */}
      <View style={rowStyles.cell}>
        <Pill variant={engagementVariant(item.engagement)} size="sm">
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
        <ChevronRight size={16} color={colors.textMuted} />
      </View>
    </TouchableOpacity>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    // @ts-ignore — web-only hover
    cursor: 'pointer',
  } as ViewStyle,

  cell: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    flex: 1,
    flexShrink: 0,
  } as ViewStyle,

  memberCell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flex: 2,
  } as ViewStyle,

  memberInfo: {
    gap: 2,
    flexShrink: 1,
  } as ViewStyle,

  memberName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,

  memberMeta: {
    fontSize: 11,
    color: colors.textSecondary,
  } as TextStyle,

  journeyName: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,

  journeyMeta: {
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: 1,
  } as TextStyle,

  noJourney: {
    fontSize: 13,
    color: colors.textMuted,
  } as TextStyle,

  lastContact: {
    fontSize: 13,
    color: colors.textPrimary,
  } as TextStyle,

  lastContactDate: {
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: 1,
  } as TextStyle,

  overdueLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.red700,
    marginTop: 1,
  } as TextStyle,

  chevronCell: {
    flex: 0,
    width: 40,
    alignItems: 'center',
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
          <AvatarCircle initials={item.avatarInitials} size={40} />
          <View style={cardStyles.nameBlock}>
            <Text style={cardStyles.name}>{item.displayName}</Text>
            <Text style={cardStyles.meta}>
              {item.age != null ? `${item.age} · ` : ''}ID {item.maskedId}
            </Text>
          </View>
          <ChevronRight size={18} color={colors.textMuted} />
        </View>

        <View style={cardStyles.pillRow}>
          <Pill variant={item.status === 'active' ? 'emerald' : 'gray'} size="sm">
            {item.status === 'active' ? 'Active' : 'Inactive'}
          </Pill>
          <Pill variant={engagementVariant(item.engagement)} size="sm">
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
    padding: spacing.lg,
    gap: spacing.sm,
    marginBottom: spacing.sm,
  } as ViewStyle,

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,

  nameBlock: {
    flex: 1,
    gap: 2,
  } as ViewStyle,

  name: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,

  meta: {
    fontSize: 12,
    color: colors.textSecondary,
  } as TextStyle,

  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  } as ViewStyle,

  journeyLine: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  } as TextStyle,

  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  } as ViewStyle,

  contactTime: {
    fontSize: 12,
    color: colors.textSecondary,
    flex: 1,
  } as TextStyle,

  overdueTag: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.red700,
  } as TextStyle,
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CHWMembersScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const navigation = useNavigation<DrawerNavigationProp<CHWTabParamList>>();
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const { data: members = [], isLoading, isError, dataUpdatedAt } = useChwMembers();

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

    // Apply filter chip.
    switch (activeFilter) {
      case 'active':
        result = result.filter((m) => m.status === 'active');
        break;
      case 'high_risk':
        // risk is always null in v1; show an empty result rather than all members.
        result = result.filter((m) => m.risk != null);
        break;
      case 'overdue':
        result = result.filter((m) => m.status === 'active' && isOverdue(m.lastContactAt));
        break;
      case 'in_journey':
        result = result.filter((m) => m.activeJourney != null);
        break;
      case 'inactive':
        result = result.filter((m) => m.status === 'inactive');
        break;
      default:
        break;
    }

    // Apply search query (name or masked ID).
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
    // Navigate to the existing CHWMemberProfileScreen inside SessionsStack.
    (navigation as any).navigate('SessionsStack', {
      screen: 'MemberProfile',
      params: { memberId },
    });
  };

  // ── Shared content ───────────────────────────────────────────────────────────
  const content = (
    <>
      {/* Header */}
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
            <Search size={16} color={colors.textMuted} style={styles.searchIcon} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search by name, ID, phone..."
              placeholderTextColor={colors.textMuted}
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

      {/* Filter chips row */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterRow}
        contentContainerStyle={styles.filterRowContent}
      >
        {FILTER_CHIPS.map((chip) => {
          const count =
            chip.key === 'all'        ? members.length :
            chip.key === 'active'     ? activeCount :
            chip.key === 'high_risk'  ? members.filter((m) => m.risk != null).length :
            chip.key === 'overdue'    ? members.filter((m) => m.status === 'active' && isOverdue(m.lastContactAt)).length :
            chip.key === 'in_journey' ? members.filter((m) => m.activeJourney != null).length :
            inactiveCount;

          const isActive = activeFilter === chip.key;
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

        <View style={styles.sortLabel}>
          <Text style={styles.sortText}>Sort: Last contact ↓</Text>
        </View>
      </ScrollView>

      {/* Body */}
      {isLoading ? (
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
            {(['Member', 'Status', 'Risk', 'Engagement', 'Active Journey', 'Last Contact', 'Top Need', ''] as const).map((col) => (
              <View
                key={col}
                style={[
                  styles.headCell,
                  col === 'Member' && styles.memberHeadCell,
                  col === ''       && styles.chevronHeadCell,
                ]}
              >
                <Text style={styles.headText}>{col}</Text>
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

      {/* Pagination footer (web, static v1) */}
      {Platform.OS === 'web' && !isLoading && filtered.length > 0 && (
        <View style={styles.paginationRow}>
          <Text style={styles.paginationInfo}>
            Showing {filtered.length} of {members.length} member{members.length !== 1 ? 's' : ''}
          </Text>
        </View>
      )}
    </>
  );

  // ── Platform shell ────────────────────────────────────────────────────────────
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
    flex: 1,
    backgroundColor: colors.pageBg,
  } as ViewStyle,

  nativeScroll: {
    padding: spacing.lg,
    flexGrow: 1,
  } as ViewStyle,

  // ── Header ──────────────────────────────────────────────────────────────────

  headerRow: {
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
    alignItems: Platform.OS === 'web' ? 'flex-end' : 'flex-start',
    justifyContent: 'space-between',
    marginBottom: spacing.xl,
    gap: spacing.md,
  } as ViewStyle,

  subtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 4,
  } as TextStyle,

  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1,
  } as ViewStyle,

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: radius.lg,
    paddingHorizontal: spacing.sm,
    backgroundColor: '#fff',
    height: 38,
    width: Platform.OS === 'web' ? 280 : undefined,
    flex: Platform.OS === 'web' ? undefined : 1,
  } as ViewStyle,

  searchIcon: {
    marginRight: spacing.xs,
  } as ViewStyle,

  searchInput: {
    flex: 1,
    fontSize: 13,
    color: colors.textPrimary,
    height: '100%',
    // @ts-ignore — outline not in RN types but needed on web
    outlineStyle: 'none',
  } as TextStyle,

  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexShrink: 0,
  } as ViewStyle,

  addButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,

  // ── Filter chips ─────────────────────────────────────────────────────────────

  filterRow: {
    marginBottom: spacing.lg,
  } as ViewStyle,

  filterRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.md,
  } as ViewStyle,

  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#fff',
  } as ViewStyle,

  filterChipActive: {
    backgroundColor: '#ecfdf5',
    borderColor: '#a7f3d0',
  } as ViewStyle,

  filterChipText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
  } as TextStyle,

  filterChipTextActive: {
    color: '#065f46',
    fontWeight: '600',
  } as TextStyle,

  sortLabel: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,

  sortText: {
    fontSize: 13,
    color: colors.textSecondary,
  } as TextStyle,

  // ── Table (web) ──────────────────────────────────────────────────────────────

  tableCard: {
    overflow: 'hidden',
    padding: 0,
  } as ViewStyle,

  tableHead: {
    flexDirection: 'row',
    backgroundColor: '#f9fafb',
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  } as ViewStyle,

  headCell: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexShrink: 0,
  } as ViewStyle,

  memberHeadCell: {
    flex: 2,
  } as ViewStyle,

  chevronHeadCell: {
    flex: 0,
    width: 40,
  } as ViewStyle,

  headText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  } as TextStyle,

  // ── Card list (native) ───────────────────────────────────────────────────────

  cardList: {
    gap: spacing.sm,
  } as ViewStyle,

  // ── States ───────────────────────────────────────────────────────────────────

  loadingWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xxxl,
  } as ViewStyle,

  loadingText: {
    fontSize: 14,
    color: colors.textSecondary,
  } as TextStyle,

  emptyCard: {
    padding: spacing.xxl,
    alignItems: 'center',
    gap: spacing.md,
  } as ViewStyle,

  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,

  emptyText: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    maxWidth: 360,
  } as TextStyle,

  // ── Pagination ───────────────────────────────────────────────────────────────

  paginationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  } as ViewStyle,

  paginationInfo: {
    fontSize: 13,
    color: colors.textSecondary,
  } as TextStyle,
});

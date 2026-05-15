/**
 * CHWResourcesScreen — Resource folder browser for CHWs.
 *
 * Displays a categorised grid of community/clinical resources the CHW can
 * browse, pin, or share with members. Search + category filter chips narrow
 * the visible set. A right rail shows recently pinned resources and quick
 * stats.
 *
 * All data is mocked inline for v1. Replace with a real query hook once the
 * /chw/resources endpoint ships.
 */

import React, { useMemo, useState } from 'react';
import {
  Alert,
  View,
  Text,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Platform,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Search,
  FolderOpen,
  Bookmark,
  Share2,
  ExternalLink,
  Home,
  Utensils,
  Brain,
  Stethoscope,
  LifeBuoy,
  Scale,
  Bus,
  Folder,
  FileText,
  TrendingUp,
  MapPin,
  Phone,
} from 'lucide-react-native';

import { AppShell, PageHeader, Card, Pill, RightRail, StatTile } from '../../components/ui';
import { colors, spacing, radius } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';
import { useChwResources, type ChwResourceItem } from '../../hooks/useApiQueries';

// ─── Icon-circle bg colours per category ─────────────────────────────────────
// Mirrors the live API enum (housing | food | mental_health | rehab |
// healthcare | legal | transportation | other) so every resource gets a
// distinct, recognisable colour treatment instead of collapsing to one tone.

const CATEGORY_ICON_BG: Record<Exclude<ResourceCategory, 'all'>, string> = {
  housing:        colors.red100,
  food:           colors.orange100,
  mental_health:  colors.purple100,
  rehab:          colors.rose100,
  healthcare:     colors.emerald100,
  legal:          colors.blue100,
  transportation: colors.amber100,
  other:          colors.slate100,
};

const CATEGORY_ICON_COLOR: Record<Exclude<ResourceCategory, 'all'>, string> = {
  housing:        colors.red700,
  food:           colors.orange700,
  mental_health:  colors.purple700,
  rehab:          colors.rose700,
  healthcare:     colors.emerald700,
  legal:          colors.blue700,
  transportation: colors.amber800,
  other:          colors.slate700,
};

// ─── Types ────────────────────────────────────────────────────────────────────

type ResourceCategory =
  | 'all'
  | 'housing'
  | 'food'
  | 'mental_health'
  | 'rehab'
  | 'healthcare'
  | 'legal'
  | 'transportation'
  | 'other';

interface Resource {
  id: string;
  title: string;
  organization: string;
  category: Exclude<ResourceCategory, 'all'>;
  description: string;
  phone?: string;
  address?: string;
  tags: string[];
  isPinned: boolean;
  updatedAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  all:            'All',
  housing:        'Housing',
  food:           'Food',
  mental_health:  'Mental Health',
  rehab:          'Recovery',
  healthcare:     'Healthcare',
  legal:          'Legal',
  transportation: 'Transit',
  other:          'Other',
};

const CATEGORY_PILL: Record<
  Exclude<ResourceCategory, 'all'>,
  'red' | 'amber' | 'purple' | 'pink' | 'emerald' | 'blue' | 'orange' | 'gray-muted'
> = {
  housing:        'red',
  food:           'amber',
  mental_health:  'purple',
  rehab:          'pink',
  healthcare:     'emerald',
  legal:          'blue',
  transportation: 'orange',
  other:          'gray-muted',
};

const CategoryIcon: React.FC<{ category: Exclude<ResourceCategory, 'all'>; size?: number; iconColor?: string }> = ({
  category,
  size = 16,
  iconColor,
}) => {
  const color = iconColor ?? colors.textSecondary;
  switch (category) {
    case 'housing':        return <Home size={size} color={color} />;
    case 'food':           return <Utensils size={size} color={color} />;
    case 'mental_health':  return <Brain size={size} color={color} />;
    case 'rehab':          return <LifeBuoy size={size} color={color} />;
    case 'healthcare':     return <Stethoscope size={size} color={color} />;
    case 'legal':          return <Scale size={size} color={color} />;
    case 'transportation': return <Bus size={size} color={color} />;
    case 'other':          return <Folder size={size} color={color} />;
    default:               return <FileText size={size} color={color} />;
  }
};

// ─── Resource card ────────────────────────────────────────────────────────────

interface ResourceCardProps {
  resource: Resource;
}

function ResourceCard({ resource }: ResourceCardProps): React.JSX.Element {
  const pillVariant = CATEGORY_PILL[resource.category];
  const iconBg = CATEGORY_ICON_BG[resource.category];
  const iconColor = CATEGORY_ICON_COLOR[resource.category];

  return (
    <Card style={styles.resourceCard}>
      {/* Icon-circle + title + category pill */}
      <View style={styles.resourceCardHeader}>
        <View style={[styles.iconCircle, { backgroundColor: iconBg }]}>
          <CategoryIcon category={resource.category} size={22} iconColor={iconColor} />
        </View>
        <View style={styles.resourceMeta}>
          <Text style={styles.resourceTitle} numberOfLines={2}>
            {resource.title}
          </Text>
          <Pill variant={pillVariant} size="sm">
            {CATEGORY_LABELS[resource.category]}
          </Pill>
        </View>
        {resource.isPinned && (
          <Bookmark size={14} color={colors.primary} fill={colors.primary} />
        )}
      </View>

      {/* Meta rows: address, phone, org */}
      <View style={styles.metaBlock}>
        {resource.address !== undefined && (
          <View style={styles.metaRow}>
            <MapPin size={13} color={colors.textMuted} />
            <Text style={styles.metaText} numberOfLines={1}>{resource.address}</Text>
          </View>
        )}
        {resource.phone !== undefined && (
          <View style={styles.metaRow}>
            <Phone size={13} color={colors.textMuted} />
            <Text style={styles.metaText}>{resource.phone}</Text>
          </View>
        )}
        <View style={styles.metaRow}>
          <ExternalLink size={13} color={colors.textMuted} />
          <Text style={styles.metaText}>{resource.organization}</Text>
        </View>
      </View>

      {/* Verified badge */}
      <View style={styles.verifiedRow}>
        <Share2 size={11} color={colors.emerald700} />
        <Text style={styles.verifiedText}>Verified · updated {resource.updatedAt}</Text>
      </View>

      {/* Action button row */}
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={styles.btnPrimary}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`Refer a member to ${resource.title}`}
          onPress={() => {
            const blurb = [
              resource.title,
              resource.address ? `📍 ${resource.address}` : null,
              resource.phone ? `📞 ${resource.phone}` : null,
              '',
              resource.description,
            ]
              .filter(Boolean)
              .join('\n');
            Alert.alert(
              `Refer a member to ${resource.title}`,
              `Open Messages and paste this blurb into a thread:\n\n${blurb}`,
            );
          }}
        >
          <Text style={styles.btnPrimaryText}>Refer a member</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btnSecondary}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`Copy SMS link for ${resource.title}`}
          onPress={() => {
            const sms = resource.phone
              ? `${resource.title}: call ${resource.phone}.${resource.address ? ` Located at ${resource.address}.` : ''}`
              : `${resource.title}.${resource.address ? ` Located at ${resource.address}.` : ''} ${resource.description}`;
            Alert.alert(
              'SMS-ready blurb',
              `Copy this into a text to your member:\n\n${sms}`,
            );
          }}
        >
          <Text style={styles.btnSecondaryText}>Copy SMS link</Text>
        </TouchableOpacity>
      </View>
    </Card>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * Map an API ChwResourceItem onto the screen-local Resource shape.
 *
 * The screen's ResourceCategory mirrors the live API enum 1:1, so we pass
 * `api.category` straight through to keep colour + icon variety per row.
 * Fields the API doesn't (yet) expose — organization, tags, pinning — are
 * synthesised with reasonable defaults; tags falls back to ``languages`` so
 * search keyword matching still works.
 */
function adaptApiResource(api: ChwResourceItem): Resource {
  return {
    id: api.id,
    title: api.name,
    organization: '',
    category: api.category,
    description: api.description,
    phone: api.phone ?? undefined,
    address: api.address ?? undefined,
    tags: api.languages,
    isPinned: false,
    updatedAt: new Date(api.createdAt).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    }),
  };
}

export function CHWResourcesScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<ResourceCategory>('all');

  const resourcesQuery = useChwResources({ category: activeCategory, q: query });
  const allResources = useMemo<Resource[]>(
    () => (resourcesQuery.data ?? []).map(adaptApiResource),
    [resourcesQuery.data],
  );

  // The API already filters by category + query server-side, so we just
  // surface the result. Keep the local lowercase-q double-check for the
  // 'all' case (server returns up to 50 with no q).
  const filtered = useMemo(() => {
    if (!query) return allResources;
    const lowerQuery = query.toLowerCase();
    return allResources.filter((r) =>
      r.title.toLowerCase().includes(lowerQuery) ||
      r.description.toLowerCase().includes(lowerQuery) ||
      r.tags.some((t) => t.toLowerCase().includes(lowerQuery)),
    );
  }, [allResources, query]);

  const pinnedCount = 0; // Pinning persisted server-side ships in v1.1.
  const categories = Object.keys(CATEGORY_LABELS) as ResourceCategory[];

  const userInitials = (userName ?? 'CHW')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const content = (
    <>
      <PageHeader
        title="Resource Folder"
        subtitle={
          resourcesQuery.isLoading
            ? 'Loading resources…'
            : `${allResources.length} resource${allResources.length === 1 ? '' : 's'}`
        }
        right={
          <View style={styles.searchWrap}>
            <Search size={14} color={colors.textSecondary} style={styles.searchIcon as TextStyle} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search resources…"
              placeholderTextColor={colors.textMuted}
              value={query}
              onChangeText={setQuery}
              accessibilityLabel="Search resources"
            />
          </View>
        }
      />

      {/* Category filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipRow}
        contentContainerStyle={styles.chipRowContent}
      >
        {categories.map((cat) => (
          <TouchableOpacity
            key={cat}
            onPress={() => setActiveCategory(cat)}
            style={[
              styles.filterChip,
              activeCategory === cat && styles.filterChipActive,
            ]}
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Filter by ${CATEGORY_LABELS[cat]}`}
            accessibilityState={{ selected: activeCategory === cat }}
          >
            <Text
              style={[
                styles.filterChipText,
                activeCategory === cat && styles.filterChipTextActive,
              ]}
            >
              {CATEGORY_LABELS[cat]}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Two-column grid + right rail */}
      <View style={styles.bodyRow}>
        {/* Resource grid */}
        <View style={styles.grid}>
          {filtered.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyText}>No resources match your search.</Text>
            </Card>
          ) : (
            <View style={styles.gridInner}>
              {filtered.map((resource) => (
                <ResourceCard key={resource.id} resource={resource} />
              ))}
            </View>
          )}
        </View>

        {/* Right rail — web only to avoid cluttering small screens */}
        {Platform.OS === 'web' && (
          <RightRail>
            <Card style={styles.railCard}>
              <Text style={styles.railTitle}>Quick Stats</Text>
              <View style={styles.railStats}>
                <StatTile
                  icon={<FolderOpen size={18} color={colors.emerald700} />}
                  iconBg={colors.emerald100}
                  label="Total Resources"
                  value={allResources.length}
                  style={styles.statTile}
                />
                <StatTile
                  icon={<Bookmark size={18} color={colors.blue700} />}
                  iconBg={colors.blue100}
                  label="Pinned"
                  value={pinnedCount}
                  style={styles.statTile}
                />
                <StatTile
                  icon={<TrendingUp size={18} color={colors.amber700} />}
                  iconBg={colors.amber100}
                  label="Categories"
                  value={5}
                  style={styles.statTile}
                />
              </View>
            </Card>

            <Card style={styles.railCard}>
              <Text style={styles.railTitle}>Pinned Resources</Text>
              <View style={styles.railList}>
                <Text style={styles.emptyText}>
                  Pinning ships in v1.1. Use Search to find resources fast.
                </Text>
              </View>
            </Card>
          </RightRail>
        )}
      </View>
    </>
  );

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
      activeKey="resources"
      userBlock={{
        initials: userInitials,
        name: userName ?? 'CHW',
        role: 'CHW',
      }}
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

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    height: 36,
    minWidth: 220,
  } as ViewStyle,

  searchIcon: {
    marginRight: spacing.xs,
  },

  searchInput: {
    flex: 1,
    fontSize: 13,
    color: colors.textPrimary,
    height: '100%',
    outlineStyle: 'none',
  } as unknown as TextStyle,

  chipRow: {
    marginBottom: spacing.lg,
    flexGrow: 0,
    flexShrink: 0,
  } as ViewStyle,

  chipRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.md,
  } as ViewStyle,

  filterChip: {
    alignSelf: 'flex-start',
    flexShrink: 0,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.cardBg,
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
  } as TextStyle,

  bodyRow: {
    flexDirection: 'row',
    gap: spacing.xl,
    alignItems: 'flex-start',
  } as ViewStyle,

  grid: {
    flex: 1,
  } as ViewStyle,

  gridInner: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.lg,
  } as ViewStyle,

  resourceCard: {
    padding: spacing.xl,
    // 3-col grid on web (matches mockup's grid-cols-3)
    width: Platform.OS === 'web' ? 'calc(33.333% - 11px)' as unknown as number : '100%',
    gap: spacing.sm,
  } as ViewStyle,

  resourceCardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  } as ViewStyle,

  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  resourceMeta: {
    flex: 1,
    gap: 4,
  } as ViewStyle,

  resourceTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    lineHeight: 20,
  } as TextStyle,

  metaBlock: {
    gap: 4,
  } as ViewStyle,

  metaRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
  } as ViewStyle,

  metaText: {
    flex: 1,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
  } as TextStyle,

  verifiedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,

  verifiedText: {
    fontSize: 11,
    color: colors.textSecondary,
  } as TextStyle,

  buttonRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.xs,
  } as ViewStyle,

  btnPrimary: {
    flex: 1,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 7,
    alignItems: 'center',
  } as ViewStyle,

  btnPrimaryText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#ffffff',
  } as TextStyle,

  btnSecondary: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    paddingVertical: 7,
    alignItems: 'center',
  } as ViewStyle,

  btnSecondaryText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,

  resourceOrg: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.primary,
    lineHeight: 16,
  } as TextStyle,

  emptyCard: {
    padding: spacing.xl,
    alignItems: 'center',
  } as ViewStyle,

  emptyText: {
    fontSize: 14,
    color: colors.textSecondary,
  } as TextStyle,

  railCard: {
    padding: spacing.lg,
    gap: spacing.md,
  } as ViewStyle,

  railTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  } as TextStyle,

  railStats: {
    gap: spacing.sm,
  } as ViewStyle,

  statTile: {
    padding: spacing.md,
  } as ViewStyle,

  railList: {
    gap: spacing.sm,
  } as ViewStyle,

  pinnedItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
  } as ViewStyle,

  pinnedTitle: {
    flex: 1,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 16,
  } as TextStyle,
});

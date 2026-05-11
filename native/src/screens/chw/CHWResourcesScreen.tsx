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
  HeartHandshake,
  FileText,
  TrendingUp,
} from 'lucide-react-native';

import { AppShell, PageHeader, Card, Pill, RightRail, StatTile } from '../../components/ui';
import { colors, spacing, radius } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

type ResourceCategory =
  | 'all'
  | 'housing'
  | 'food'
  | 'mental_health'
  | 'healthcare'
  | 'benefits';

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

// ─── Mock data — TODO: replace with real hook ─────────────────────────────────

// TODO: replace with real hook — GET /chw/resources
const MOCK_RESOURCES: Resource[] = [
  {
    id: 'r-001',
    title: 'Emergency Housing Assistance',
    organization: 'LA County Housing Authority',
    category: 'housing',
    description:
      'Rapid rehousing and emergency shelter vouchers for qualifying individuals and families facing homelessness.',
    phone: '(800) 593-8222',
    address: '2615 S Grand Ave, Los Angeles, CA 90007',
    tags: ['emergency', 'vouchers', 'shelter'],
    isPinned: true,
    updatedAt: '2026-05-07',
  },
  {
    id: 'r-002',
    title: 'CalFresh Application Support',
    organization: 'Hunger Action LA',
    category: 'food',
    description:
      'Walk-in CalFresh enrollment assistance. Staff speak Spanish, Korean, and Cantonese.',
    phone: '(213) 738-6363',
    address: '523 W 6th St, Los Angeles, CA 90014',
    tags: ['calFresh', 'snap', 'enrollment'],
    isPinned: true,
    updatedAt: '2026-05-06',
  },
  {
    id: 'r-003',
    title: 'Didi Hirsch Mental Health Services',
    organization: 'Didi Hirsch',
    category: 'mental_health',
    description:
      'Outpatient therapy, crisis intervention, and psychiatry for Medi-Cal members. Sliding scale available.',
    phone: '(800) 854-7771',
    address: '4760 S Sepulveda Blvd, Culver City, CA 90230',
    tags: ['therapy', 'crisis', 'medi-cal'],
    isPinned: false,
    updatedAt: '2026-05-05',
  },
  {
    id: 'r-004',
    title: 'AltaMed Health Services',
    organization: 'AltaMed',
    category: 'healthcare',
    description:
      'Community health center offering primary care, dental, and vision for underserved populations.',
    phone: '(888) 499-9303',
    address: '2040 Camfield Ave, Los Angeles, CA 90040',
    tags: ['primary care', 'dental', 'vision'],
    isPinned: true,
    updatedAt: '2026-05-04',
  },
  {
    id: 'r-005',
    title: 'Social Security Disability Benefits Navigator',
    organization: 'Bet Tzedek Legal Services',
    category: 'benefits',
    description:
      'Free legal support for SSI/SSDI applications and appeals. Priority for seniors and people with disabilities.',
    phone: '(323) 939-0506',
    address: '3250 Wilshire Blvd #1300, Los Angeles, CA 90010',
    tags: ['SSI', 'SSDI', 'legal'],
    isPinned: false,
    updatedAt: '2026-05-03',
  },
  {
    id: 'r-006',
    title: 'PATH (People Assisting The Homeless)',
    organization: 'PATH',
    category: 'housing',
    description:
      'Street outreach, temporary housing, and permanent supportive housing navigation services.',
    phone: '(323) 644-2200',
    address: '340 N Madison Ave, Los Angeles, CA 90004',
    tags: ['outreach', 'permanent housing', 'navigation'],
    isPinned: false,
    updatedAt: '2026-05-02',
  },
  {
    id: 'r-007',
    title: 'LA Food Bank Emergency Pantry',
    organization: 'LA Regional Food Bank',
    category: 'food',
    description:
      'Weekly emergency food distributions. No income verification required. Walk-ins welcome.',
    phone: '(323) 234-3030',
    address: '1734 E 41st St, Los Angeles, CA 90058',
    tags: ['pantry', 'emergency', 'walk-in'],
    isPinned: false,
    updatedAt: '2026-05-01',
  },
  {
    id: 'r-008',
    title: 'Medi-Cal Enrollment Specialist',
    organization: 'Covered California',
    category: 'benefits',
    description:
      'Free certified enrollment assistance for Medi-Cal and Covered California plans.',
    phone: '(800) 300-1506',
    address: 'Multiple locations — call for nearest site',
    tags: ['medi-cal', 'insurance', 'enrollment'],
    isPinned: false,
    updatedAt: '2026-04-30',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  all:           'All',
  housing:       'Housing',
  food:          'Food',
  mental_health: 'Mental Health',
  healthcare:    'Healthcare',
  benefits:      'Benefits',
};

const CATEGORY_PILL: Record<Exclude<ResourceCategory, 'all'>, 'blue' | 'amber' | 'purple' | 'emerald' | 'orange'> = {
  housing:       'blue',
  food:          'amber',
  mental_health: 'purple',
  healthcare:    'emerald',
  benefits:      'orange',
};

const CategoryIcon: React.FC<{ category: Exclude<ResourceCategory, 'all'>; size?: number }> = ({
  category,
  size = 16,
}) => {
  const iconColor = colors.textSecondary;
  switch (category) {
    case 'housing':       return <Home size={size} color={iconColor} />;
    case 'food':          return <Utensils size={size} color={iconColor} />;
    case 'mental_health': return <Brain size={size} color={iconColor} />;
    case 'healthcare':    return <Stethoscope size={size} color={iconColor} />;
    case 'benefits':      return <HeartHandshake size={size} color={iconColor} />;
    default:              return <FileText size={size} color={iconColor} />;
  }
};

// ─── Resource card ────────────────────────────────────────────────────────────

interface ResourceCardProps {
  resource: Resource;
}

function ResourceCard({ resource }: ResourceCardProps): React.JSX.Element {
  const pillVariant = CATEGORY_PILL[resource.category];

  return (
    <Card style={styles.resourceCard}>
      <View style={styles.resourceCardHeader}>
        <View style={styles.resourceMeta}>
          <CategoryIcon category={resource.category} size={14} />
          <Pill variant={pillVariant} size="sm">
            {CATEGORY_LABELS[resource.category]}
          </Pill>
        </View>
        <View style={styles.resourceActions}>
          {resource.isPinned && (
            <Bookmark size={14} color={colors.primary} fill={colors.primary} />
          )}
          <TouchableOpacity
            accessible
            accessibilityLabel={`Share ${resource.title}`}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Share2 size={14} color={colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity
            accessible
            accessibilityLabel={`Open ${resource.title}`}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <ExternalLink size={14} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      <Text style={styles.resourceTitle} numberOfLines={2}>
        {resource.title}
      </Text>
      <Text style={styles.resourceOrg}>{resource.organization}</Text>
      <Text style={styles.resourceDescription} numberOfLines={3}>
        {resource.description}
      </Text>

      {resource.phone !== undefined && (
        <Text style={styles.resourcePhone}>{resource.phone}</Text>
      )}

      <View style={styles.resourceTags}>
        {resource.tags.map((tag) => (
          <View key={tag} style={styles.tag}>
            <Text style={styles.tagText}>{tag}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CHWResourcesScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<ResourceCategory>('all');

  const filtered = useMemo(() => {
    return MOCK_RESOURCES.filter((r) => {
      const matchesCategory =
        activeCategory === 'all' || r.category === activeCategory;
      const lowerQuery = query.toLowerCase();
      const matchesQuery =
        query.length === 0 ||
        r.title.toLowerCase().includes(lowerQuery) ||
        r.organization.toLowerCase().includes(lowerQuery) ||
        r.description.toLowerCase().includes(lowerQuery) ||
        r.tags.some((t) => t.toLowerCase().includes(lowerQuery));
      return matchesCategory && matchesQuery;
    });
  }, [query, activeCategory]);

  const pinnedCount = MOCK_RESOURCES.filter((r) => r.isPinned).length;
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
        subtitle={`${MOCK_RESOURCES.length} resources · last updated 2 days ago`}
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
                  value={MOCK_RESOURCES.length}
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
                {MOCK_RESOURCES.filter((r) => r.isPinned).map((r) => (
                  <TouchableOpacity key={r.id} style={styles.pinnedItem} accessible accessibilityLabel={r.title}>
                    <CategoryIcon category={r.category} size={12} />
                    <Text style={styles.pinnedTitle} numberOfLines={2}>
                      {r.title}
                    </Text>
                  </TouchableOpacity>
                ))}
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
  } as TextStyle,

  chipRow: {
    marginBottom: spacing.lg,
  } as ViewStyle,

  chipRowContent: {
    gap: spacing.sm,
    paddingRight: spacing.md,
  } as ViewStyle,

  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.cardBg,
  } as ViewStyle,

  filterChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  } as ViewStyle,

  filterChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textSecondary,
  } as TextStyle,

  filterChipTextActive: {
    color: colors.cardBg,
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
    padding: spacing.lg,
    width: Platform.OS === 'web' ? 'calc(50% - 8px)' as unknown as number : '100%',
    gap: spacing.sm,
  } as ViewStyle,

  resourceCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as ViewStyle,

  resourceMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,

  resourceActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,

  resourceTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    lineHeight: 20,
  } as TextStyle,

  resourceOrg: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.primary,
    lineHeight: 16,
  } as TextStyle,

  resourceDescription: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
  } as TextStyle,

  resourcePhone: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: '500',
  } as TextStyle,

  resourceTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  } as ViewStyle,

  tag: {
    backgroundColor: colors.gray100,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  } as ViewStyle,

  tagText: {
    fontSize: 10,
    color: colors.gray700,
    fontWeight: '500',
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

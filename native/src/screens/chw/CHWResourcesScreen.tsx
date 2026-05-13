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
  MapPin,
  Phone,
} from 'lucide-react-native';

import { AppShell, PageHeader, Card, Pill, RightRail, StatTile } from '../../components/ui';
import { colors, spacing, radius } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';

// ─── Icon-circle bg colours per category (matches mockup) ────────────────────

const CATEGORY_ICON_BG: Record<Exclude<ResourceCategory, 'all'>, string> = {
  housing:       colors.red100,
  food:          colors.orange100,
  mental_health: colors.purple100,
  healthcare:    colors.emerald100,
  benefits:      colors.emerald100,
};

const CATEGORY_ICON_COLOR: Record<Exclude<ResourceCategory, 'all'>, string> = {
  housing:       colors.red700,
  food:          colors.orange700,
  mental_health: colors.purple700,
  healthcare:    colors.emerald700,
  benefits:      colors.emerald700,
};

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

const CategoryIcon: React.FC<{ category: Exclude<ResourceCategory, 'all'>; size?: number; iconColor?: string }> = ({
  category,
  size = 16,
  iconColor,
}) => {
  const color = iconColor ?? colors.textSecondary;
  switch (category) {
    case 'housing':       return <Home size={size} color={color} />;
    case 'food':          return <Utensils size={size} color={color} />;
    case 'mental_health': return <Brain size={size} color={color} />;
    case 'healthcare':    return <Stethoscope size={size} color={color} />;
    case 'benefits':      return <HeartHandshake size={size} color={color} />;
    default:              return <FileText size={size} color={color} />;
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
        >
          <Text style={styles.btnPrimaryText}>Refer a member</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btnSecondary}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`Copy SMS link for ${resource.title}`}
        >
          <Text style={styles.btnSecondaryText}>Copy SMS link</Text>
        </TouchableOpacity>
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

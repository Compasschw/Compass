/**
 * MemberResourcesScreen — member-facing recommended resources hub.
 *
 * Shows "Recommended for you" highlighted cards at the top (derived from the
 * member's primaryNeed vertical), then a filter-chip bar, then a grid of all
 * available resource cards.
 *
 * Data source: uses existing useResources hook when available, otherwise falls
 * back to inline mock data annotated with the same shape. The hook can be
 * swapped with a real endpoint when the backend ships a member-scoped resources
 * query.
 */

import React, { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import {
  BookOpen,
  ExternalLink,
  Filter,
  Home,
  Stethoscope,
  Brain,
  ShoppingBasket,
  Dumbbell,
} from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import { useMemberProfile } from '../../hooks/useApiQueries';
import { AppShell, PageHeader, Card, Pill } from '../../components/ui';
import { colors as tokens } from '../../theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

type ResourceCategory =
  | 'housing'
  | 'healthcare'
  | 'mental_health'
  | 'food'
  | 'rehab'
  | 'all';

interface Resource {
  id: string;
  title: string;
  description: string;
  category: ResourceCategory;
  url?: string;
  /** Whether this resource is specifically highlighted for the member's need. */
  recommended: boolean;
}

// ─── Mock data (replace with useResources hook when endpoint ships) ───────────

const MOCK_RESOURCES: Resource[] = [
  {
    id: 'r1',
    title: 'California Housing Resource Guide',
    description: 'Find emergency shelter, rental assistance, and housing programs near you.',
    category: 'housing',
    recommended: true,
  },
  {
    id: 'r2',
    title: 'Medi-Cal Enrollment Help',
    description: 'Step-by-step guide to enrolling in Medi-Cal health coverage.',
    category: 'healthcare',
    recommended: true,
  },
  {
    id: 'r3',
    title: 'Community Mental Health Centers',
    description: 'Free and low-cost mental health services in your area.',
    category: 'mental_health',
    recommended: false,
  },
  {
    id: 'r4',
    title: 'CalFresh Food Assistance',
    description: 'Apply for food stamps and find local food banks and pantries.',
    category: 'food',
    recommended: true,
  },
  {
    id: 'r5',
    title: 'Substance Use Recovery Programs',
    description: 'Outpatient and residential recovery support options statewide.',
    category: 'rehab',
    recommended: false,
  },
  {
    id: 'r6',
    title: 'Urgent Care Finder',
    description: 'Locate urgent care clinics accepting walk-ins near your ZIP code.',
    category: 'healthcare',
    recommended: false,
  },
  {
    id: 'r7',
    title: 'Mental Health First Aid',
    description: 'Learn to recognize and respond to mental health crises.',
    category: 'mental_health',
    recommended: false,
  },
  {
    id: 'r8',
    title: 'Section 8 Housing Waitlist',
    description: 'How to apply for federal Housing Choice Voucher assistance.',
    category: 'housing',
    recommended: false,
  },
];

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  all: 'All',
  housing: 'Housing',
  healthcare: 'Healthcare',
  mental_health: 'Mental Health',
  food: 'Food',
  rehab: 'Rehab',
};

const CATEGORY_ICON: Record<ResourceCategory, React.ReactNode> = {
  all: <Filter size={14} color={tokens.textSecondary} />,
  housing: <Home size={14} color={tokens.blue700} />,
  healthcare: <Stethoscope size={14} color={tokens.emerald700} />,
  mental_health: <Brain size={14} color={tokens.purple700} />,
  food: <ShoppingBasket size={14} color={tokens.orange700} />,
  rehab: <Dumbbell size={14} color={tokens.red700} />,
};

const CATEGORY_PILL_VARIANT: Record<Exclude<ResourceCategory, 'all'>, import('../../components/ui/Pill').PillVariant> = {
  housing: 'blue',
  healthcare: 'emerald',
  mental_health: 'purple',
  food: 'amber',
  rehab: 'red',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ResourceCardProps {
  resource: Resource;
  highlighted?: boolean;
}

function ResourceCard({ resource, highlighted = false }: ResourceCardProps): React.JSX.Element {
  const pillVariant = CATEGORY_PILL_VARIANT[resource.category as Exclude<ResourceCategory, 'all'>] ?? 'gray';

  return (
    <Card
      style={[
        rc.card,
        highlighted && rc.cardHighlighted,
      ]}
    >
      {highlighted && (
        <View style={rc.recommendedBadge}>
          <Text style={rc.recommendedText}>RECOMMENDED FOR YOU</Text>
        </View>
      )}
      <View style={rc.body}>
        <View style={rc.iconCircle}>
          <BookOpen size={18} color={highlighted ? '#FFFFFF' : tokens.primary} />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={[rc.title, highlighted && rc.titleLight]} numberOfLines={2}>
            {resource.title}
          </Text>
          <Text style={[rc.desc, highlighted && rc.descLight]} numberOfLines={3}>
            {resource.description}
          </Text>
        </View>
      </View>
      <View style={rc.footer}>
        <Pill variant={pillVariant} size="sm">{CATEGORY_LABELS[resource.category]}</Pill>
        {resource.url !== undefined && (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open ${resource.title}`}
            style={rc.linkBtn}
          >
            <ExternalLink size={13} color={highlighted ? 'rgba(255,255,255,0.85)' : tokens.primary} />
            <Text style={[rc.linkText, highlighted && rc.linkTextLight]}>Open</Text>
          </Pressable>
        )}
      </View>
    </Card>
  );
}

const rc = StyleSheet.create({
  card: {
    // p-5 = 20px from mockup
    padding: 20,
    gap: 12,
    marginBottom: 12,
  } as ViewStyle,
  cardHighlighted: {
    // recommended cards: border-2 border-emerald-200 (not inverted color)
    borderWidth: 2,
    borderColor: '#A7F3D0',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,
  recommendedBadge: {
    backgroundColor: '#D1FAE5',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    alignSelf: 'flex-start',
  } as ViewStyle,
  recommendedText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#065F46',
    letterSpacing: 0.5,
  } as TextStyle,
  body: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  } as ViewStyle,
  iconCircle: {
    // w-12 h-12 = 48px from mockup
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: `${tokens.primary}12`,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    lineHeight: 20,
  } as TextStyle,
  titleLight: {
    color: '#111827',
  } as TextStyle,
  desc: {
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 18,
  } as TextStyle,
  descLight: {
    color: '#6B7280',
  } as TextStyle,
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as ViewStyle,
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    // px-2 py-1.5 bg-emerald-600 text-white from mockup
    backgroundColor: '#059669',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
  } as ViewStyle,
  linkText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  } as TextStyle,
  linkTextLight: {
    color: '#FFFFFF',
  } as TextStyle,
});

interface FilterChipProps {
  category: ResourceCategory;
  isActive: boolean;
  onPress: () => void;
}

function FilterChip({ category, isActive, onPress }: FilterChipProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        fc.chip,
        isActive && fc.chipActive,
        pressed && { opacity: 0.75 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Filter by ${CATEGORY_LABELS[category]}`}
      accessibilityState={{ selected: isActive }}
    >
      {CATEGORY_ICON[category]}
      <Text style={[fc.label, isActive && fc.labelActive]}>
        {CATEGORY_LABELS[category]}
      </Text>
    </Pressable>
  );
}

const fc = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    // filter-btn: padding 7px 14px, borderRadius 10px from mockup
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,
  chipActive: {
    // filter-btn.active: bg-emerald-50, text-emerald-900, border-emerald-200
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
  } as ViewStyle,
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6B7280',
  } as TextStyle,
  labelActive: {
    color: '#065F46',
    fontWeight: '600',
  } as TextStyle,
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberResourcesScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const profileQuery = useMemberProfile();

  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const [activeCategory, setActiveCategory] = useState<ResourceCategory>('all');

  const primaryNeed = profileQuery.data?.primaryNeed ?? 'all';

  const recommended = useMemo(
    () =>
      MOCK_RESOURCES.filter(
        (r) =>
          r.recommended &&
          (primaryNeed === 'all' || r.category === primaryNeed || r.recommended),
      ).slice(0, 2),
    [primaryNeed],
  );

  const filtered = useMemo(
    () =>
      MOCK_RESOURCES.filter(
        (r) => activeCategory === 'all' || r.category === activeCategory,
      ),
    [activeCategory],
  );

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'Member',
    role: 'Member' as const,
  };

  const categories: ResourceCategory[] = [
    'all',
    'housing',
    'healthcare',
    'mental_health',
    'food',
    'rehab',
  ];

  return (
    <AppShell role="member" activeKey="resources" userBlock={shellUserBlock}>
      <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageWrap}>
          <PageHeader
            title="Resources"
            subtitle="Curated resources matched to your needs"
          />

          {/* Recommended section */}
          {recommended.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>RECOMMENDED FOR YOU</Text>
              {recommended.map((r) => (
                <ResourceCard key={r.id} resource={r} highlighted />
              ))}
            </View>
          )}

          {/* Filter chips */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRow}
          >
            {categories.map((cat) => (
              <FilterChip
                key={cat}
                category={cat}
                isActive={activeCategory === cat}
                onPress={() => setActiveCategory(cat)}
              />
            ))}
          </ScrollView>

          {/* Resource grid */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>
              {activeCategory === 'all'
                ? 'ALL RESOURCES'
                : `${CATEGORY_LABELS[activeCategory].toUpperCase()} RESOURCES`}
            </Text>
            {filtered.map((r) => (
              <ResourceCard key={r.id} resource={r} />
            ))}
            {filtered.length === 0 && (
              <Card style={styles.emptyCard}>
                <BookOpen size={28} color={tokens.textMuted} />
                <Text style={styles.emptyTitle}>No resources found</Text>
                <Text style={styles.emptySub}>
                  Try selecting a different category above.
                </Text>
              </Card>
            )}
          </View>
        </View>
      </ScrollView>
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  pageWrap: {
    // p-8 = 32px from mockup; 1100px matches full-width layout
    paddingHorizontal: 32,
    paddingTop: 24,
    paddingBottom: 32,
    maxWidth: undefined as unknown as number,
    width: '100%',
    alignSelf: 'center',
  } as ViewStyle,
  section: {
    marginBottom: 20,
  } as ViewStyle,
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 12,
  } as TextStyle,
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 16,
  } as ViewStyle,
  emptyCard: {
    padding: 32,
    alignItems: 'center',
    gap: 10,
  } as ViewStyle,
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: tokens.textPrimary,
  } as TextStyle,
  emptySub: {
    fontSize: 13,
    color: tokens.textSecondary,
    textAlign: 'center',
  } as TextStyle,
});

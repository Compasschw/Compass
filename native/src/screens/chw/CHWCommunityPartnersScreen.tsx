/**
 * CHWCommunityPartnersScreen — Community partner organization directory.
 *
 * Displays a searchable, filterable directory of community partner
 * organizations the CHW can refer members to or collaborate with.
 * Cards show contact info, service types, capacity status, and languages.
 *
 * All data is mocked inline for v1. Replace with a real query hook once the
 * /chw/community-partners endpoint ships.
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Platform,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Search,
  Building2,
  Phone,
  Mail,
  MapPin,
  Globe,
  Users,
  Star,
  CheckCircle2,
  Clock,
  XCircle,
} from 'lucide-react-native';

import { AppShell, PageHeader, Card, Pill, RightRail, StatTile } from '../../components/ui';
import { colors, spacing, radius } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

type ServiceType =
  | 'all'
  | 'housing'
  | 'food'
  | 'mental_health'
  | 'healthcare'
  | 'benefits'
  | 'legal';

type CapacityStatus = 'accepting' | 'waitlist' | 'closed';

interface CommunityPartner {
  id: string;
  name: string;
  description: string;
  serviceTypes: Exclude<ServiceType, 'all'>[];
  capacityStatus: CapacityStatus;
  phone: string;
  email: string;
  address: string;
  website?: string;
  languages: string[];
  rating: number;
  totalReferrals: number;
  isPriority: boolean;
  lastContactedAt?: string;
}

// ─── Mock data — TODO: replace with real hook ─────────────────────────────────

// TODO: replace with real hook — GET /chw/community-partners
const MOCK_PARTNERS: CommunityPartner[] = [
  {
    id: 'cp-001',
    name: 'LA County Housing Authority',
    description:
      'Rapid rehousing, emergency shelter vouchers, and permanent supportive housing navigation for qualifying individuals and families.',
    serviceTypes: ['housing'],
    capacityStatus: 'accepting',
    phone: '(800) 593-8222',
    email: 'referrals@hacla.org',
    address: '2615 S Grand Ave, Los Angeles, CA 90007',
    website: 'https://hacla.org',
    languages: ['English', 'Spanish', 'Tagalog'],
    rating: 4.6,
    totalReferrals: 28,
    isPriority: true,
    lastContactedAt: '2026-05-06',
  },
  {
    id: 'cp-002',
    name: 'Didi Hirsch Mental Health Services',
    description:
      'Outpatient therapy, psychiatric services, and crisis intervention. Medi-Cal accepted. Sliding scale available for uninsured.',
    serviceTypes: ['mental_health'],
    capacityStatus: 'waitlist',
    phone: '(800) 854-7771',
    email: 'intake@didihirsch.org',
    address: '4760 S Sepulveda Blvd, Culver City, CA 90230',
    website: 'https://didihirsch.org',
    languages: ['English', 'Spanish', 'Korean', 'Farsi'],
    rating: 4.8,
    totalReferrals: 19,
    isPriority: true,
  },
  {
    id: 'cp-003',
    name: 'Hunger Action LA',
    description:
      'CalFresh enrollment assistance, food pantry referrals, and nutrition education. Multilingual staff on-site.',
    serviceTypes: ['food', 'benefits'],
    capacityStatus: 'accepting',
    phone: '(213) 738-6363',
    email: 'help@hungeractionla.org',
    address: '523 W 6th St, Los Angeles, CA 90014',
    languages: ['English', 'Spanish', 'Korean', 'Cantonese'],
    rating: 4.5,
    totalReferrals: 35,
    isPriority: false,
    lastContactedAt: '2026-05-04',
  },
  {
    id: 'cp-004',
    name: 'AltaMed Health Services',
    description:
      'Federally qualified health center offering primary care, dental, vision, and behavioral health for underserved populations.',
    serviceTypes: ['healthcare'],
    capacityStatus: 'accepting',
    phone: '(888) 499-9303',
    email: 'newpatients@altamed.org',
    address: '2040 Camfield Ave, Los Angeles, CA 90040',
    website: 'https://altamed.org',
    languages: ['English', 'Spanish', 'Vietnamese'],
    rating: 4.7,
    totalReferrals: 22,
    isPriority: true,
    lastContactedAt: '2026-05-07',
  },
  {
    id: 'cp-005',
    name: 'Bet Tzedek Legal Services',
    description:
      'Free legal aid for SSI/SSDI applications, tenant rights, and public benefits appeals. Priority for seniors and people with disabilities.',
    serviceTypes: ['legal', 'benefits'],
    capacityStatus: 'accepting',
    phone: '(323) 939-0506',
    email: 'intake@bettzedek.org',
    address: '3250 Wilshire Blvd #1300, Los Angeles, CA 90010',
    website: 'https://bettzedek.org',
    languages: ['English', 'Spanish', 'Hebrew', 'Russian'],
    rating: 4.9,
    totalReferrals: 11,
    isPriority: false,
  },
  {
    id: 'cp-006',
    name: 'PATH (People Assisting The Homeless)',
    description:
      'Street outreach teams, bridge housing, and permanent supportive housing navigation across Los Angeles County.',
    serviceTypes: ['housing'],
    capacityStatus: 'accepting',
    phone: '(323) 644-2200',
    email: 'referrals@epath.org',
    address: '340 N Madison Ave, Los Angeles, CA 90004',
    website: 'https://epath.org',
    languages: ['English', 'Spanish'],
    rating: 4.4,
    totalReferrals: 17,
    isPriority: false,
    lastContactedAt: '2026-04-30',
  },
  {
    id: 'cp-007',
    name: 'SHIELDS for Families',
    description:
      'Substance use disorder treatment, mental health services, and family preservation programs for South LA residents.',
    serviceTypes: ['mental_health', 'healthcare'],
    capacityStatus: 'closed',
    phone: '(323) 242-5000',
    email: 'intake@shieldsforfamilies.org',
    address: '8920 S Figueroa St, Los Angeles, CA 90003',
    languages: ['English', 'Spanish'],
    rating: 4.3,
    totalReferrals: 8,
    isPriority: false,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  all:          'All',
  housing:      'Housing',
  food:         'Food',
  mental_health:'Mental Health',
  healthcare:   'Healthcare',
  benefits:     'Benefits',
  legal:        'Legal',
};

const SERVICE_PILL: Record<Exclude<ServiceType, 'all'>, 'blue' | 'amber' | 'purple' | 'emerald' | 'orange' | 'gray'> = {
  housing:      'blue',
  food:         'amber',
  mental_health:'purple',
  healthcare:   'emerald',
  benefits:     'orange',
  legal:        'gray',
};

const CAPACITY_CONFIG: Record<CapacityStatus, { label: string; pillVariant: 'emerald' | 'amber' | 'red'; Icon: React.FC<{ size: number; color: string }> }> = {
  accepting: { label: 'Accepting',  pillVariant: 'emerald', Icon: CheckCircle2 },
  waitlist:  { label: 'Waitlist',   pillVariant: 'amber',   Icon: Clock        },
  closed:    { label: 'Closed',     pillVariant: 'red',     Icon: XCircle      },
};

function StarRating({ rating }: { rating: number }): React.JSX.Element {
  return (
    <View style={ratingStyles.row} accessibilityLabel={`Rating: ${rating} out of 5`}>
      <Star size={12} color={colors.amber700} fill={colors.amber700} />
      <Text style={ratingStyles.text}>{rating.toFixed(1)}</Text>
    </View>
  );
}

const ratingStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  } as ViewStyle,
  text: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.amber700,
  } as unknown as TextStyle,
});

// ─── Partner card ─────────────────────────────────────────────────────────────

interface PartnerCardProps {
  partner: CommunityPartner;
}

/** Derive short initials from partner name (up to 4 chars, like mockup's FJV/SDFB) */
function getPartnerInitials(name: string): string {
  return name
    .split(/[\s&-]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 4);
}

/** Deterministic color from name for the logo circle */
const LOGO_COLORS = ['#dc2626', '#f97316', '#8b5cf6', '#7c3aed', '#ec4899', '#0891b2', '#16a34a', '#1e40af'];
function getLogoColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) { hash = (hash * 31 + name.charCodeAt(i)) >>> 0; }
  return LOGO_COLORS[hash % LOGO_COLORS.length];
}

function PartnerCard({ partner }: PartnerCardProps): React.JSX.Element {
  const cap = CAPACITY_CONFIG[partner.capacityStatus];
  const CapIcon = cap.Icon;
  const logoInitials = getPartnerInitials(partner.name);
  const logoColor = getLogoColor(partner.name);

  return (
    <Card style={cardStyles.card}>
      {/* Header row: logo-circle + name/pills + capacity badge */}
      <View style={cardStyles.headerRow}>
        <View style={[cardStyles.logoCircle, { backgroundColor: logoColor }]}>
          <Text style={cardStyles.logoText}>{logoInitials}</Text>
        </View>
        <View style={cardStyles.nameBlock}>
          <Text style={cardStyles.name} numberOfLines={2}>{partner.name}</Text>
          <View style={cardStyles.serviceRow}>
            {partner.serviceTypes.map((st) => (
              <Pill key={st} variant={SERVICE_PILL[st]} size="sm">
                {SERVICE_TYPE_LABELS[st]}
              </Pill>
            ))}
          </View>
        </View>
        <Pill variant={cap.pillVariant} size="sm">{cap.label}</Pill>
      </View>

      {/* Contact meta */}
      <View style={cardStyles.contactBlock}>
        <View style={cardStyles.contactRow}>
          <MapPin size={12} color={colors.textSecondary} />
          <Text style={cardStyles.contactText} numberOfLines={1}>{partner.address}</Text>
        </View>
        <View style={cardStyles.contactRow}>
          <Phone size={12} color={colors.textSecondary} />
          <Text style={cardStyles.contactText}>{partner.phone}</Text>
        </View>
      </View>

      {/* Referral stats + rating */}
      <View style={cardStyles.statsRow}>
        <Text style={cardStyles.statsText}>
          {partner.totalReferrals} referrals sent
        </Text>
        <View style={cardStyles.footerRight}>
          <StarRating rating={partner.rating} />
          {partner.isPriority && (
            <Star size={11} color={colors.amber700} fill={colors.amber700} />
          )}
        </View>
      </View>

      {/* Languages */}
      <View style={cardStyles.languagePills}>
        {partner.languages.slice(0, 3).map((lang) => (
          <View key={lang} style={cardStyles.langTag}>
            <Text style={cardStyles.langText}>{lang}</Text>
          </View>
        ))}
        {partner.languages.length > 3 && (
          <View style={cardStyles.langTag}>
            <Text style={cardStyles.langText}>+{partner.languages.length - 3}</Text>
          </View>
        )}
      </View>

      {/* Action button row */}
      <View style={cardStyles.buttonRow}>
        <TouchableOpacity
          style={cardStyles.btnPrimary}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`Refer a member to ${partner.name}`}
        >
          <Text style={cardStyles.btnPrimaryText}>Refer a member</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={cardStyles.btnSecondary}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`Send a message to ${partner.name}`}
        >
          <Text style={cardStyles.btnSecondaryText}>Send a message</Text>
        </TouchableOpacity>
      </View>
    </Card>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    padding: spacing.xl,
    gap: spacing.sm,
    width: Platform.OS === 'web' ? 'calc(50% - 8px)' as unknown as number : '100%',
  } as ViewStyle,

  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  } as ViewStyle,

  logoCircle: {
    width: 48,
    height: 48,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  logoText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.5,
  } as TextStyle,

  nameBlock: {
    flex: 1,
    gap: spacing.xs,
  } as ViewStyle,

  name: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    lineHeight: 20,
  } as unknown as TextStyle,

  serviceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  } as ViewStyle,

  contactBlock: {
    gap: 4,
  } as ViewStyle,

  contactRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
  } as ViewStyle,

  contactText: {
    flex: 1,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
  } as unknown as TextStyle,

  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    paddingTop: spacing.sm,
  } as ViewStyle,

  statsText: {
    flex: 1,
    fontSize: 11,
    color: colors.textSecondary,
  } as unknown as TextStyle,

  footerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  } as ViewStyle,

  languagePills: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexWrap: 'wrap',
  } as ViewStyle,

  langTag: {
    backgroundColor: colors.gray100,
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
  } as ViewStyle,

  langText: {
    fontSize: 10,
    color: colors.gray700,
    fontWeight: '500',
  } as unknown as TextStyle,

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
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CHWCommunityPartnersScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const [query, setQuery] = useState('');
  const [activeType, setActiveType] = useState<ServiceType>('all');

  const filtered = useMemo(() => {
    const lq = query.toLowerCase();
    return MOCK_PARTNERS.filter((p) => {
      const typeMatch =
        activeType === 'all' || p.serviceTypes.includes(activeType as Exclude<ServiceType, 'all'>);
      const qMatch =
        query.length === 0 ||
        p.name.toLowerCase().includes(lq) ||
        p.description.toLowerCase().includes(lq) ||
        p.languages.some((l) => l.toLowerCase().includes(lq));
      return typeMatch && qMatch;
    });
  }, [query, activeType]);

  const acceptingCount = MOCK_PARTNERS.filter((p) => p.capacityStatus === 'accepting').length;
  const priorityCount  = MOCK_PARTNERS.filter((p) => p.isPriority).length;
  const serviceTypes   = Object.keys(SERVICE_TYPE_LABELS) as ServiceType[];

  const userInitials = (userName ?? 'CHW')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const content = (
    <>
      <PageHeader
        title="Community Partners"
        subtitle={`${MOCK_PARTNERS.length} partners · ${acceptingCount} currently accepting referrals`}
        right={
          <View style={styles.searchWrap}>
            <Search size={14} color={colors.textSecondary} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search partners or languages…"
              placeholderTextColor={colors.textMuted}
              value={query}
              onChangeText={setQuery}
              accessibilityLabel="Search community partners"
            />
          </View>
        }
      />

      {/* Service type filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipRow}
        contentContainerStyle={styles.chipRowContent}
      >
        {serviceTypes.map((type) => (
          <TouchableOpacity
            key={type}
            onPress={() => setActiveType(type)}
            style={[styles.filterChip, activeType === type && styles.filterChipActive]}
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Filter by ${SERVICE_TYPE_LABELS[type]}`}
            accessibilityState={{ selected: activeType === type }}
          >
            <Text style={[styles.filterChipText, activeType === type && styles.filterChipTextActive]}>
              {SERVICE_TYPE_LABELS[type]}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Body */}
      <View style={styles.bodyRow}>
        {/* Partner cards grid */}
        <View style={styles.grid}>
          {filtered.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyText}>No partners match your search.</Text>
            </Card>
          ) : (
            <View style={styles.gridInner}>
              {filtered.map((partner) => (
                <PartnerCard key={partner.id} partner={partner} />
              ))}
            </View>
          )}
        </View>

        {Platform.OS === 'web' && (
          <RightRail>
            <Card style={styles.railCard}>
              <Text style={styles.railTitle}>Directory Stats</Text>
              <StatTile
                icon={<Building2 size={18} color={colors.emerald700} />}
                iconBg={colors.emerald100}
                label="Total Partners"
                value={MOCK_PARTNERS.length}
                style={styles.statTile}
              />
              <StatTile
                icon={<CheckCircle2 size={18} color={colors.blue700} />}
                iconBg={colors.blue100}
                label="Accepting Now"
                value={acceptingCount}
                style={styles.statTile}
              />
              <StatTile
                icon={<Star size={18} color={colors.amber700} />}
                iconBg={colors.amber100}
                label="Priority Partners"
                value={priorityCount}
                style={styles.statTile}
              />
            </Card>

            <Card style={styles.railCard}>
              <Text style={styles.railTitle}>Priority Partners</Text>
              <View style={styles.priorityList}>
                {MOCK_PARTNERS.filter((p) => p.isPriority).map((p) => (
                  <View key={p.id} style={styles.priorityItem}>
                    <Building2 size={12} color={colors.primary} />
                    <View style={styles.priorityText}>
                      <Text style={styles.priorityName} numberOfLines={1}>{p.name}</Text>
                      <Pill variant={CAPACITY_CONFIG[p.capacityStatus].pillVariant} size="sm">
                        {CAPACITY_CONFIG[p.capacityStatus].label}
                      </Pill>
                    </View>
                  </View>
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
        <ScrollView contentContainerStyle={styles.nativeScroll} showsVerticalScrollIndicator={false}>
          {content}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <AppShell
      role="chw"
      activeKey="partners"
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

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    height: 36,
    gap: spacing.xs,
    minWidth: 260,
  } as ViewStyle,

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
  } as unknown as TextStyle,

  filterChipTextActive: {
    color: '#065f46',
  } as unknown as TextStyle,

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

  emptyCard: {
    padding: spacing.xl,
    alignItems: 'center',
  } as ViewStyle,

  emptyText: {
    fontSize: 14,
    color: colors.textSecondary,
  } as unknown as TextStyle,

  railCard: {
    padding: spacing.lg,
    gap: spacing.md,
  } as ViewStyle,

  railTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  } as unknown as TextStyle,

  statTile: {
    padding: spacing.md,
  } as ViewStyle,

  priorityList: {
    gap: spacing.sm,
  } as ViewStyle,

  priorityItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
  } as ViewStyle,

  priorityText: {
    flex: 1,
    gap: 4,
  } as ViewStyle,

  priorityName: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textPrimary,
  } as unknown as TextStyle,
});

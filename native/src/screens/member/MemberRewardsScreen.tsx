/**
 * MemberRewardsScreen — rewards catalog and wellness points hub (feat/ui-revamp).
 *
 * Re-skinned to AppShell layout. Original data hooks (useMemberProfile,
 * useMemberRewards) are preserved. New hooks (useRewardsCatalog,
 * useMemberRewardsBalance, useMemberRedemptions) augment with real backend data.
 *
 * Shows:
 *   - Progress ring / hero balance card (AppShell page)
 *   - 3 featured reward cards from the catalog
 *   - Earn-more list (static tips)
 *   - Redemption history
 */

import React, { useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ArrowLeft, Gift, Sparkles } from 'lucide-react-native';

import { colors } from '../../theme/colors';
import {
  useMemberProfile,
  useMemberRewards,
  useRewardsCatalog,
  useMemberRewardsBalance,
  useMemberRedemptions,
  useCreateRedemption,
  type RewardTransaction,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { useNavigation } from '@react-navigation/native';
import { AppShell, PageHeader, Card, Pill } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';

const REWARD_ACTION_ICONS: Record<string, string> = {
  session_completed: '✅',
  follow_through: '⭐',
  redeemed: '🎁',
};

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function MemberRewardsScreen(): React.JSX.Element {
  const navigation = useNavigation();
  const { userName } = useAuth();
  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const profileQuery = useMemberProfile();
  const rewardsQuery = useMemberRewards();
  const catalogQuery = useRewardsCatalog();
  const memberId = profileQuery.data?.id ?? '';
  const balanceQuery = useMemberRewardsBalance(memberId);
  const redemptionsQuery = useMemberRedemptions(memberId);
  const createRedemption = useCreateRedemption(memberId);

  const [localBalance, setLocalBalance] = useState<number | null>(null);
  // Prefer the new /rewards/balance endpoint; fall back to profile.rewardsBalance.
  const apiBalance =
    balanceQuery.data?.currentBalance ?? profileQuery.data?.rewardsBalance ?? 0;
  const balance = localBalance ?? apiBalance;

  // Up to 3 featured items from the live catalog.
  const featuredCatalog = useMemo(
    () => (catalogQuery.data ?? []).filter((i) => i.isActive).slice(0, 3),
    [catalogQuery.data],
  );

  // Group all active live-catalog items by fulfillment type for the full-list view.
  const groupedCatalog = useMemo(() => {
    const map = new Map<string, typeof featuredCatalog>();
    for (const item of (catalogQuery.data ?? []).filter((i) => i.isActive)) {
      const bucket = map.get(item.fulfillmentType) ?? [];
      map.set(item.fulfillmentType, [...bucket, item]);
    }
    return [...map.entries()];
  }, [catalogQuery.data]);

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'Member',
    role: 'Member' as const,
  };

  if (profileQuery.isLoading) {
    return (
      <AppShell role="member" activeKey="rewards" userBlock={shellUserBlock}>
        <LoadingSkeleton variant="card" />
        <LoadingSkeleton variant="rows" rows={4} />
      </AppShell>
    );
  }

  return (
    <AppShell role="member" activeKey="rewards" userBlock={shellUserBlock} badges={{ wellnessPoints: balance }}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageWrap}>

        {/* Native-only inline back button. AppShell renders the sidebar on
            web (which provides chrome to navigate elsewhere); on native there
            is no sidebar, so without this back button members had no way to
            leave the Rewards screen. */}
        {Platform.OS !== 'web' && (
          <Pressable
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={styles.backBtnInline}
          >
            <ArrowLeft size={20} color="#1F2937" />
            <Text style={styles.backBtnInlineLabel}>Back</Text>
          </Pressable>
        )}

        <PageHeader
          title="Wellness Rewards"
          subtitle="Earn points for taking care of yourself. Redeem for real rewards."
        />

        {/* Hero balance centerpiece card */}
        <Card style={styles.heroCenterpiece}>
          <View style={styles.heroRingRow}>
            {/* Progress ring visual */}
            <View style={styles.ringOuter}>
              <View style={styles.ringInner}>
                <Text style={styles.ringTrophy}>🏆</Text>
                <Text style={styles.ringBalance}>{balance.toLocaleString()}</Text>
                <Text style={styles.ringUnit}>wellness pts</Text>
              </View>
            </View>

            {/* Next reward CTA */}
            <View style={styles.heroNextReward}>
              <Text style={styles.heroNextLabel}>NEXT REWARD</Text>
              {balanceQuery.data?.nextUnlockItem != null ? (
                <>
                  <Text style={styles.heroNextTitle}>
                    Earn {balanceQuery.data.pointsToNext} more for{' '}
                    {balanceQuery.data.nextUnlockItem.name}!
                  </Text>
                  <Text style={styles.heroNextSub}>
                    You're almost there. Complete your active journey to unlock.
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.heroNextTitle}>Earn 80 more for $25 grocery card!</Text>
                  <Text style={styles.heroNextSub}>
                    You're 84% of the way there. Complete your Food Assistance journey to unlock.
                  </Text>
                </>
              )}
            </View>
          </View>

          {/* 3 mini stat tiles */}
          <View style={styles.heroStatRow}>
            <View style={styles.heroStatTile}>
              <Text style={styles.heroStatLabel}>Earned this month</Text>
              <Text style={styles.heroStatValue}>+175</Text>
            </View>
            <View style={styles.heroStatTile}>
              <Text style={styles.heroStatLabel}>Lifetime</Text>
              <Text style={[styles.heroStatValue, { color: '#1E3320' }]}>{balance.toLocaleString()}</Text>
            </View>
            <View style={styles.heroStatTile}>
              <Text style={styles.heroStatLabel}>Streak</Text>
              <Text style={[styles.heroStatValue, { color: '#D97706' }]}>4 wks 🔥</Text>
            </View>
          </View>
        </Card>

        {/* Featured live-catalog items (from /rewards/catalog) */}
        {featuredCatalog.length > 0 && (
          <View style={styles.categorySection}>
            <Text style={styles.categoryLabel}>FEATURED REWARDS</Text>
            {featuredCatalog.map((item) => {
              const canAfford = balance >= item.costPoints;
              return (
                <Card key={item.id} style={styles.catalogCard}>
                  <Text style={styles.catalogEmoji}>{item.imageEmoji}</Text>
                  <View style={styles.catalogInfo}>
                    <Text style={styles.catalogName}>{item.name}</Text>
                    <Text style={styles.catalogDesc} numberOfLines={2}>
                      {item.description}
                    </Text>
                    <Text style={styles.catalogCost}>{item.costPoints.toLocaleString()} pts</Text>
                  </View>
                  <Pressable
                    onPress={async () => {
                      if (!canAfford) {
                        Alert.alert(
                          'Insufficient points',
                          `You need ${item.costPoints - balance} more points to redeem ${item.name}.`,
                        );
                        return;
                      }
                      Alert.alert(
                        `Redeem ${item.name}?`,
                        `This will use ${item.costPoints} points. Current balance: ${balance} pts.`,
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Confirm',
                            onPress: async () => {
                              try {
                                await createRedemption.mutateAsync(item.id);
                                setLocalBalance(balance - item.costPoints);
                                Alert.alert('Redemption submitted', `Your ${item.name} request has been submitted.`);
                              } catch {
                                Alert.alert('Error', 'Could not submit redemption. Please try again.');
                              }
                            },
                          },
                        ],
                      );
                    }}
                    disabled={!canAfford}
                    style={[styles.redeemBtn, !canAfford && styles.redeemBtnDisabled]}
                    accessibilityRole="button"
                    accessibilityLabel={`Redeem ${item.name} for ${item.costPoints} points`}
                    accessibilityState={{ disabled: !canAfford }}
                  >
                    <Text style={[styles.redeemBtnText, !canAfford && styles.redeemBtnTextDisabled]}>
                      Redeem
                    </Text>
                  </Pressable>
                </Card>
              );
            })}
          </View>
        )}

        {/* Full live catalog grouped by fulfillment type */}
        {catalogQuery.isLoading && (
          <LoadingSkeleton variant="rows" rows={3} />
        )}
        {catalogQuery.isError && (
          <Text style={styles.historyEmpty}>
            Could not load rewards catalog. Pull to refresh.
          </Text>
        )}
        {!catalogQuery.isLoading &&
          !catalogQuery.isError &&
          groupedCatalog.length === 0 && (
            <Text style={styles.historyEmpty}>No rewards available right now.</Text>
          )}
        {groupedCatalog.map(([category, items]) => (
          <View key={category} style={styles.categorySection}>
            <Text style={styles.categoryLabel}>
              {category.replace(/_/g, ' ').toUpperCase()}
            </Text>
            {items.map((item) => {
              const canAfford = balance >= item.costPoints;
              return (
                <Card key={item.id} style={styles.catalogCard}>
                  <Text style={styles.catalogEmoji}>{item.imageEmoji}</Text>
                  <View style={styles.catalogInfo}>
                    <Text style={styles.catalogName}>{item.name}</Text>
                    <Text style={styles.catalogDesc} numberOfLines={2}>
                      {item.description}
                    </Text>
                    <Text style={styles.catalogCost}>
                      {item.costPoints.toLocaleString()} pts
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => {
                      if (!canAfford) {
                        Alert.alert(
                          'Insufficient points',
                          `You need ${item.costPoints - balance} more points to redeem ${item.name}.`,
                        );
                        return;
                      }
                      Alert.alert(
                        `Redeem ${item.name}?`,
                        `This will use ${item.costPoints} points. Current balance: ${balance} pts.`,
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Confirm',
                            onPress: async () => {
                              try {
                                await createRedemption.mutateAsync(item.id);
                                setLocalBalance(balance - item.costPoints);
                                Alert.alert(
                                  'Redemption submitted',
                                  `Your ${item.name} request has been submitted.`,
                                );
                              } catch {
                                Alert.alert(
                                  'Error',
                                  'Could not submit redemption. Please try again.',
                                );
                              }
                            },
                          },
                        ],
                      );
                    }}
                    disabled={!canAfford || createRedemption.isPending}
                    style={[styles.redeemBtn, !canAfford && styles.redeemBtnDisabled]}
                    accessibilityRole="button"
                    accessibilityLabel={`Redeem ${item.name} for ${item.costPoints} points`}
                    accessibilityState={{ disabled: !canAfford }}
                  >
                    <Text
                      style={[
                        styles.redeemBtnText,
                        !canAfford && styles.redeemBtnTextDisabled,
                      ]}
                    >
                      Redeem
                    </Text>
                  </Pressable>
                </Card>
              );
            })}
          </View>
        ))}

        {/* Earn-more tips */}
        <Card style={styles.historyCard}>
          <View style={styles.historyHeader}>
            <Sparkles size={16} color={colors.compassGold} />
            <Text style={styles.historyTitle}>How to earn more points</Text>
          </View>
          {[
            { emoji: '✅', text: 'Complete a session with your CHW (+50 pts)' },
            { emoji: '⭐', text: 'Follow through on a goal milestone (+25 pts)' },
            { emoji: '📋', text: 'Complete your member profile (+10 pts)' },
          ].map((tip) => (
            <View key={tip.text} style={styles.tipRow}>
              <Text style={styles.tipEmoji}>{tip.emoji}</Text>
              <Text style={styles.tipText}>{tip.text}</Text>
            </View>
          ))}
        </Card>

        {/* Redemption history */}
        <Card style={styles.historyCard}>
          <View style={styles.historyHeader}>
            <Gift size={16} color={colors.compassGold} />
            <Text style={styles.historyTitle}>Recent activity</Text>
          </View>
          <FlatList
            data={rewardsQuery.data ?? []}
            keyExtractor={(item) => item.id}
            renderItem={({ item, index }) => (
              <RewardRow item={item} showDivider={index > 0} />
            )}
            scrollEnabled={false}
            ListEmptyComponent={
              <Text style={styles.historyEmpty}>
                No reward activity yet. Earn points by completing sessions.
              </Text>
            }
          />
        </Card>

        <View style={{ height: 24 }} />
        </View>
      </ScrollView>
    </AppShell>
  );
}

function RewardRow({ item, showDivider }: { item: RewardTransaction; showDivider: boolean }): React.JSX.Element {
  const isPositive = item.points > 0;
  return (
    <>
      {showDivider ? <View style={styles.divider} /> : null}
      <View style={styles.rewardRow}>
        <Text style={styles.rewardIcon}>{REWARD_ACTION_ICONS[item.action] ?? '•'}</Text>
        <View style={styles.rewardInfo}>
          <Text style={styles.rewardAction} numberOfLines={1}>
            {item.action.replace(/_/g, ' ')}
          </Text>
          <Text style={styles.rewardDate}>{formatDate(item.createdAt)}</Text>
        </View>
        <Text
          style={[
            styles.rewardPoints,
            { color: isPositive ? colors.secondary : colors.destructive },
          ]}
        >
          {isPositive ? '+' : ''}{item.points} pts
        </Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F4F1ED' },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, alignItems: 'center' },
  // 560 px — single-column rewards catalog matches form screens.
  pageWrap: {
    width: '100%',
    maxWidth: undefined as unknown as number,
    alignSelf: 'center',
    padding: 16,
  },

  // Native-only inline back button (web users navigate via the sidebar).
  backBtnInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginBottom: 8,
    alignSelf: 'flex-start',
  },
  backBtnInlineLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1F2937',
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#F4F1ED',
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
  },
  backBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDD6CC',
  },
  headerTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: '#1E3320',
  },

  heroCenterpiece: {
    // mock: card p-8 bg-gradient from emerald-50/50 to white text-center
    backgroundColor: '#F0FDF4',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#A7F3D0',
    paddingVertical: 32,
    paddingHorizontal: 24,
    marginBottom: 24,
    gap: 24,
  },
  heroRingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // gap-12 = 48px from mockup
    gap: 48,
    justifyContent: 'center',
  },
  ringOuter: {
    // ring-progress: 200×200 from mockup conic-gradient
    width: 160,
    height: 160,
    borderRadius: 80,
    borderWidth: 10,
    borderColor: '#10B981',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    flexShrink: 0,
  },
  ringInner: {
    alignItems: 'center',
    gap: 2,
  },
  ringTrophy: {
    // text-5xl from mockup
    fontSize: 36,
  },
  ringBalance: {
    fontFamily: 'DMSans_700Bold',
    // text-4xl from mockup
    fontSize: 32,
    color: '#059669',
    lineHeight: 38,
  },
  ringUnit: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
  },
  heroNextReward: {
    flex: 1,
    gap: 8,
    // max-w-xs from mockup
    maxWidth: 320,
  },
  heroNextLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    letterSpacing: 0.8,
    color: '#047857',
    textTransform: 'uppercase',
  },
  heroNextTitle: {
    fontFamily: 'DMSans_700Bold',
    // text-2xl from mockup
    fontSize: 22,
    color: '#111827',
    lineHeight: 30,
  },
  heroNextSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#4B5563',
    lineHeight: 20,
  },
  heroStatRow: {
    flexDirection: 'row',
    gap: 16,
    justifyContent: 'center',
    // max-w-2xl mx-auto from mockup
    maxWidth: 672,
    alignSelf: 'center',
    width: '100%',
  },
  heroStatTile: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#F3F4F6',
    padding: 12,
    alignItems: 'center',
    gap: 4,
  },
  heroStatLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
    textAlign: 'center',
  },
  heroStatValue: {
    fontFamily: 'DMSans_700Bold',
    // text-2xl from mockup
    fontSize: 22,
    color: '#059669',
  },

  categorySection: { marginBottom: 16 },
  categoryLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    letterSpacing: 1,
    color: '#6B7280',
    marginBottom: 8,
  },
  catalogCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#F1F5F4',
    padding: 20,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  catalogEmoji: {
    // text-5xl from mock's card emoji thumbnail
    fontSize: 36,
    width: 56,
    textAlign: 'center',
  },
  catalogInfo: {
    flex: 1,
    gap: 4,
  },
  catalogName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#111827',
  },
  catalogDesc: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 18,
  },
  catalogCost: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    // text-sm font-bold text-emerald-600 from mockup
    fontSize: 14,
    color: '#059669',
    marginTop: 2,
  },
  redeemBtn: {
    // bg-emerald-600 from mockup
    backgroundColor: '#059669',
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 10,
  },
  redeemBtnDisabled: {
    backgroundColor: '#E5E7EB',
  },
  redeemBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#FFFFFF',
  },
  redeemBtnTextDisabled: {
    color: '#9CA3AF',
  },

  historyCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    marginTop: 8,
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  historyTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#1E3320',
  },
  historyEmpty: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
    paddingVertical: 12,
  },
  rewardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  rewardIcon: {
    fontSize: 18,
    width: 28,
    textAlign: 'center',
  },
  rewardInfo: { flex: 1, gap: 1 },
  rewardAction: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#1E3320',
  },
  rewardDate: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
  },
  rewardPoints: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
  },
  divider: {
    height: 1,
    backgroundColor: '#DDD6CC',
  },
  tipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 7,
    borderTopWidth: 1,
    borderTopColor: '#F4F1ED',
  },
  tipEmoji: {
    fontSize: 16,
    width: 24,
    textAlign: 'center',
  },
  tipText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#1E3320',
    flex: 1,
    lineHeight: 18,
  },
});

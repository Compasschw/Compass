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

import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gift, Sparkles } from 'lucide-react-native';

import { colors } from '../../theme/colors';
import {
  redemptionCatalog,
  type RedemptionItem,
} from '../../data/mock';
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
import { AppShell, PageHeader, Card, Pill } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';

interface Props {
  navigation: { goBack: () => void };
}

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

export function MemberRewardsScreen({ navigation }: Props): React.JSX.Element {
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

  // Group legacy mock catalog items by category.
  const grouped = useMemo(() => {
    const map = new Map<string, RedemptionItem[]>();
    for (const item of redemptionCatalog) {
      const bucket = map.get(item.category) ?? [];
      map.set(item.category, [...bucket, item]);
    }
    return [...map.entries()];
  }, []);

  // Up to 3 featured items from the live catalog.
  const featuredCatalog = useMemo(
    () => (catalogQuery.data ?? []).filter((i) => i.isActive).slice(0, 3),
    [catalogQuery.data],
  );

  const handleRedeem = useCallback(
    (item: RedemptionItem) => {
      if (balance < item.pointsCost) {
        Alert.alert(
          'Insufficient points',
          `You need ${item.pointsCost - balance} more points to redeem ${item.name}.`,
        );
        return;
      }
      Alert.alert(
        `Redeem ${item.name}?`,
        `This will use ${item.pointsCost} points. Current balance: ${balance} pts.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Confirm',
            onPress: () => {
              setLocalBalance(balance - item.pointsCost);
              Alert.alert('Redemption submitted', `Your ${item.name} request has been submitted.`);
            },
          },
        ],
      );
    },
    [balance],
  );

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

        <PageHeader
          title="Rewards"
          subtitle="Earn wellness points and redeem rewards"
        />

        {/* Hero balance card */}
        <Card style={styles.heroCard}>
          <View style={styles.heroHeader}>
            <Sparkles color="#FFFFFF" size={16} />
            <Text style={styles.heroLabel}>YOUR BALANCE</Text>
            <Sparkles color="#FFFFFF" size={16} />
          </View>
          <Text style={styles.heroValue}>{balance.toLocaleString()}</Text>
          <Text style={styles.heroUnit}>points</Text>
          {balanceQuery.data?.nextUnlockItem != null && (
            <Text style={styles.heroSub}>
              {balanceQuery.data.pointsToNext} more points to unlock{' '}
              {balanceQuery.data.nextUnlockItem.imageEmoji}{' '}
              {balanceQuery.data.nextUnlockItem.name}
            </Text>
          )}
          {balanceQuery.data?.nextUnlockItem == null && (
            <Text style={styles.heroSub}>
              Earn points for completing sessions and reaching goal milestones.
            </Text>
          )}
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

        {/* Legacy mock catalog grouped by category */}
        {grouped.map(([category, items]) => (
          <View key={category} style={styles.categorySection}>
            <Text style={styles.categoryLabel}>
              {category.toUpperCase()}
            </Text>
            {items.map((item) => {
              const canAfford = balance >= item.pointsCost;
              return (
                <Card key={item.id} style={styles.catalogCard}>
                  <Text style={styles.catalogEmoji}>{item.emoji}</Text>
                  <View style={styles.catalogInfo}>
                    <Text style={styles.catalogName}>{item.name}</Text>
                    <Text style={styles.catalogDesc} numberOfLines={2}>
                      {item.description}
                    </Text>
                    <Text style={styles.catalogCost}>{item.pointsCost} pts</Text>
                  </View>
                  <Pressable
                    onPress={() => handleRedeem(item)}
                    disabled={!canAfford}
                    style={[styles.redeemBtn, !canAfford && styles.redeemBtnDisabled]}
                    accessibilityRole="button"
                    accessibilityLabel={`Redeem ${item.name} for ${item.pointsCost} points`}
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
    maxWidth: 560,
    alignSelf: 'center',
    padding: 16,
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

  heroCard: {
    backgroundColor: colors.primary,
    borderRadius: 18,
    paddingVertical: 28,
    paddingHorizontal: 20,
    alignItems: 'center',
    marginBottom: 20,
    gap: 4,
  },
  heroHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  heroLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    letterSpacing: 1,
    color: '#FFFFFF',
  },
  heroValue: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 56,
    lineHeight: 60,
    color: '#FFFFFF',
  },
  heroUnit: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: 'rgba(255,255,255,0.85)',
  },
  heroSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: 'rgba(255,255,255,0.85)',
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 20,
    lineHeight: 16,
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
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 14,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  catalogEmoji: {
    fontSize: 28,
    width: 40,
    textAlign: 'center',
  },
  catalogInfo: {
    flex: 1,
    gap: 2,
  },
  catalogName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#1E3320',
  },
  catalogDesc: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
    lineHeight: 16,
  },
  catalogCost: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: colors.compassGold,
    marginTop: 2,
  },
  redeemBtn: {
    backgroundColor: colors.compassGold,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  redeemBtnDisabled: {
    backgroundColor: '#DDD6CC',
  },
  redeemBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#FFFFFF',
  },
  redeemBtnTextDisabled: {
    color: '#6B7280',
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

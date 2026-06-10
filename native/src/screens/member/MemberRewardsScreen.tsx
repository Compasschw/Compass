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
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  Flame,
  Gift,
  Star,
  Trophy,
} from 'lucide-react-native';

import { colors as tokens, numerals, spacing, radius } from '../../theme/tokens';
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
import { AppShell, EmptyState, PageHeader, Card, PressableCard, SectionHeader, PageWrap } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';

/**
 * Returns the appropriate lucide icon for a reward action type.
 * Falls back to a ClipboardList icon for unknown actions.
 */
function RewardActionIcon({ action }: { action: string }): React.JSX.Element {
  switch (action) {
    case 'session_completed':
      return (
        <CheckCircle2
          size={18}
          color={tokens.emerald700}
          strokeWidth={2}
          accessibilityLabel="session completed"
        />
      );
    case 'follow_through':
      return (
        <Star
          size={18}
          color={tokens.amber700}
          strokeWidth={2}
          accessibilityLabel="goal milestone achieved"
        />
      );
    case 'redeemed':
      return (
        <Gift
          size={18}
          color={tokens.primary}
          strokeWidth={2}
          accessibilityLabel="reward redeemed"
        />
      );
    default:
      return (
        <ClipboardList
          size={18}
          color={tokens.primary}
          strokeWidth={2}
        />
      );
  }
}

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
      <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <PageWrap style={styles.pageWrap}>

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
            <ArrowLeft size={20} color={tokens.textPrimary} />
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
                <Trophy
                  size={36}
                  color={tokens.primary}
                  strokeWidth={2}
                  accessibilityLabel="wellness trophy"
                />
                <Text style={[styles.ringBalance, numerals.tabular]}>{balance.toLocaleString()}</Text>
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
              <Text style={[styles.heroStatValue, numerals.tabular]}>+175</Text>
            </View>
            <View style={styles.heroStatTile}>
              <Text style={styles.heroStatLabel}>Lifetime</Text>
              <Text style={[styles.heroStatValue, { color: tokens.textPrimary }, numerals.tabular]}>{balance.toLocaleString()}</Text>
            </View>
            <View style={styles.heroStatTile}>
              <Text style={styles.heroStatLabel}>Streak</Text>
              <View style={styles.streakRow}>
                <Text style={[styles.heroStatValue, { color: tokens.amber700 }, numerals.tabular]}>4 wks</Text>
                <Flame
                  size={18}
                  color={tokens.amber700}
                  strokeWidth={2}
                  accessibilityLabel="fire streak indicator"
                />
              </View>
            </View>
          </View>
        </Card>

        {/* Featured live-catalog items (from /rewards/catalog) */}
        {featuredCatalog.length > 0 && (
          <View style={styles.categorySection}>
            <SectionHeader title="Featured Rewards" marginBottom={spacing.sm} />
            {featuredCatalog.map((item) => {
              const canAfford = balance >= item.costPoints;
              return (
                <PressableCard key={item.id} style={styles.catalogCard}>
                  <Text style={styles.catalogEmoji}>{item.imageEmoji}</Text>
                  <View style={styles.catalogInfo}>
                    <Text style={styles.catalogName}>{item.name}</Text>
                    <Text style={styles.catalogDesc} numberOfLines={2}>
                      {item.description}
                    </Text>
                    <Text style={[styles.catalogCost, numerals.tabular]}>{item.costPoints.toLocaleString()} pts</Text>
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
                </PressableCard>
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
            <SectionHeader
              title={category.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
              marginBottom={spacing.sm}
            />
            {items.map((item) => {
              const canAfford = balance >= item.costPoints;
              return (
                <PressableCard key={item.id} style={styles.catalogCard}>
                  <Text style={styles.catalogEmoji}>{item.imageEmoji}</Text>
                  <View style={styles.catalogInfo}>
                    <Text style={styles.catalogName}>{item.name}</Text>
                    <Text style={styles.catalogDesc} numberOfLines={2}>
                      {item.description}
                    </Text>
                    <Text style={[styles.catalogCost, numerals.tabular]}>
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
                </PressableCard>
              );
            })}
          </View>
        ))}

        {/* Earn-more tips */}
        <Card style={styles.historyCard}>
          <SectionHeader title="How to earn more points" marginBottom={spacing.md} />
          {[
            {
              icon: (
                <CheckCircle2
                  size={18}
                  color={tokens.emerald700}
                  strokeWidth={2}
                  accessibilityLabel="complete session"
                />
              ),
              text: 'Complete a session with your CHW (+50 pts)',
            },
            {
              icon: (
                <Star
                  size={18}
                  color={tokens.amber700}
                  strokeWidth={2}
                  accessibilityLabel="follow through on goal"
                />
              ),
              text: 'Follow through on a goal milestone (+25 pts)',
            },
            {
              icon: (
                <ClipboardList
                  size={18}
                  color={tokens.primary}
                  strokeWidth={2}
                  accessibilityLabel="complete profile"
                />
              ),
              text: 'Complete your member profile (+10 pts)',
            },
          ].map((tip) => (
            <View key={tip.text} style={styles.tipRow}>
              <View style={styles.tipIconWrap}>{tip.icon}</View>
              <Text style={styles.tipText}>{tip.text}</Text>
            </View>
          ))}
        </Card>

        {/* Redemption history */}
        <Card style={styles.historyCard}>
          <SectionHeader title="Recent activity" marginBottom={spacing.md} />
          <FlatList
            data={rewardsQuery.data ?? []}
            keyExtractor={(item) => item.id}
            renderItem={({ item, index }) => (
              <RewardRow item={item} showDivider={index > 0} />
            )}
            scrollEnabled={false}
            ListEmptyComponent={
              <EmptyState
                icon={Gift}
                title="Your rewards start here"
                body="Complete journey steps with your CHW to earn points."
                cta={{ label: 'View My Journey', onPress: () => (navigation as any).navigate('MemberJourney') }}
              />
            }
          />
        </Card>

        <View style={{ height: 24 }} />
        </PageWrap>
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
        <View style={styles.rewardIconWrap}>
          <RewardActionIcon action={item.action} />
        </View>
        <View style={styles.rewardInfo}>
          <Text style={styles.rewardAction} numberOfLines={1}>
            {item.action.replace(/_/g, ' ')}
          </Text>
          <Text style={styles.rewardDate}>{formatDate(item.createdAt)}</Text>
        </View>
        <Text
          style={[
            styles.rewardPoints,
            { color: isPositive ? tokens.emerald700 : tokens.red700 },
            numerals.tabular,
          ]}
        >
          {isPositive ? '+' : ''}{item.points} pts
        </Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, alignItems: 'center' },
  /** PageWrap handles max-width 560 on web; padding applied here for both platforms. */
  pageWrap: {
    padding: spacing.lg,
  },

  // Native-only inline back button (web users navigate via the sidebar).
  backBtnInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.sm,
    alignSelf: 'flex-start',
  },
  backBtnInlineLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.textPrimary,
  },

  heroCenterpiece: {
    backgroundColor: tokens.emerald100,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: tokens.emerald500 + '55',
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.xxl,
    marginBottom: spacing.xxl,
    gap: spacing.xxl,
  },
  heroRingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 48,
    justifyContent: 'center',
  },
  ringOuter: {
    width: 160,
    height: 160,
    borderRadius: 80,
    borderWidth: 10,
    borderColor: tokens.emerald500,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.cardBg,
    flexShrink: 0,
  },
  ringInner: {
    alignItems: 'center',
    gap: 2,
  },
  /** streakRow: flex row for streak value + Flame icon */
  streakRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ringBalance: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 32,
    color: tokens.primary,
    lineHeight: 38,
  },
  ringUnit: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.textSecondary,
  },
  heroNextReward: {
    flex: 1,
    gap: spacing.sm,
    maxWidth: 320,
  },
  heroNextLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    letterSpacing: 0.8,
    color: tokens.emerald700,
    textTransform: 'uppercase',
  },
  heroNextTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 22,
    color: tokens.textPrimary,
    lineHeight: 30,
  },
  heroNextSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: tokens.textSecondary,
    lineHeight: 20,
  },
  heroStatRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    justifyContent: 'center',
    maxWidth: 672,
    alignSelf: 'center',
    width: '100%',
  },
  heroStatTile: {
    flex: 1,
    backgroundColor: tokens.cardBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: tokens.gray100,
    padding: spacing.md,
    alignItems: 'center',
    gap: spacing.xs,
  },
  heroStatLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.textSecondary,
    textAlign: 'center',
  },
  heroStatValue: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 22,
    color: tokens.primary,
  },

  categorySection: { marginBottom: spacing.lg },
  /** catalogCard: inline Card equivalent — replaced by <Card> in JSX, styles applied via style prop. */
  catalogCard: {
    padding: spacing.xl,
    marginBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  catalogEmoji: {
    fontSize: 36,
    width: 56,
    textAlign: 'center',
  },
  catalogInfo: {
    flex: 1,
    gap: spacing.xs,
  },
  catalogName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: tokens.textPrimary,
  },
  catalogDesc: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.textSecondary,
    lineHeight: 18,
  },
  catalogCost: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: tokens.primary,
    marginTop: 2,
  },
  redeemBtn: {
    backgroundColor: tokens.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
    borderRadius: radius.md,
  },
  redeemBtnDisabled: {
    backgroundColor: tokens.gray100,
  },
  redeemBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: tokens.cardBg,
  },
  redeemBtnTextDisabled: {
    color: tokens.textMuted,
  },

  /** historyCard: Card padding override. */
  historyCard: {
    padding: spacing.lg,
    marginTop: spacing.sm,
  },
  historyEmpty: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.textSecondary,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  rewardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  /** rewardIconWrap: fixed-width container for reward action icon */
  rewardIconWrap: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rewardInfo: { flex: 1, gap: 1 },
  rewardAction: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: tokens.textPrimary,
  },
  rewardDate: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.textSecondary,
  },
  rewardPoints: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
  },
  divider: {
    height: 1,
    backgroundColor: tokens.cardBorder,
  },
  tipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 7,
    borderTopWidth: 1,
    borderTopColor: tokens.pageBg,
  },
  /** tipIconWrap: fixed-width container aligning tip icon with tip text */
  tipIconWrap: {
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tipText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.textPrimary,
    flex: 1,
    lineHeight: 18,
  },
});

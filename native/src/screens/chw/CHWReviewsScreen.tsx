/**
 * CHWReviewsScreen — placeholder reached from the Avg Rating stat tile on
 * the CHW Dashboard. Members will be able to leave reviews after sessions;
 * this screen will list them with rating, member name, and comment.
 *
 * For now: shows the avg rating large + a "no reviews yet" empty state.
 * Wire to a real /chw/reviews endpoint when one ships.
 */

import React from 'react';
import { ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Star } from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { useChwEarnings } from '../../hooks/useApiQueries';

export function CHWReviewsScreen(): React.JSX.Element {
  const earningsQuery = useChwEarnings();
  const avgRating = earningsQuery.data?.avgRating ?? 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.pageTitle}>Reviews</Text>
        <Text style={styles.pageSub}>What members are saying about your work.</Text>

        <View style={styles.heroCard}>
          <Text style={styles.heroValue}>
            {avgRating > 0 ? avgRating.toFixed(1) : '—'}
          </Text>
          <View style={styles.starsRow}>
            {Array.from({ length: 5 }).map((_, i) => (
              <Star
                key={i}
                size={18}
                color={colors.compassGold}
                fill={i < Math.floor(avgRating) ? colors.compassGold : 'transparent'}
              />
            ))}
          </View>
          <Text style={styles.heroLabel}>Avg rating</Text>
        </View>

        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No reviews yet</Text>
          <Text style={styles.emptySub}>
            Member reviews will appear here after completed sessions.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F4F1ED' },
  scroll: { flex: 1 },
  content: { padding: 20 },
  pageTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    color: '#1E3320',
  },
  pageSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7280',
    marginTop: 4,
    marginBottom: 20,
  },
  heroCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 24,
    alignItems: 'center',
    marginBottom: 16,
    gap: 8,
  },
  heroValue: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 48,
    lineHeight: 52,
    color: colors.foreground,
  },
  starsRow: {
    flexDirection: 'row',
    gap: 4,
  },
  heroLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: '#6B7280',
  },
  emptyCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 24,
    alignItems: 'center',
    gap: 6,
  },
  emptyTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#1E3320',
  },
  emptySub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
  },
});

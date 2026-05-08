/**
 * TestimonialsList — drop-in component for the CHW Profile screen.
 *
 * Renders:
 *   - A summary header: filled/empty star bar, avg rating, and review count
 *     ("★★★★☆ 4.7 · 23 reviews")
 *   - Up to `limit` approved testimonial cards (author initial, stars, text, date)
 *   - An empty state when rating_count is 0
 *
 * Props:
 *   chwId   — the CHW's UUID string
 *   limit   — max testimonials to show inline (default 3)
 *
 * Data fetching:
 *   Two sequential fetches on mount — summary then list. Both fire on
 *   initial render and can be triggered to refetch via the `refetch` ref
 *   pattern (not needed for the MVP embed use-case).
 *
 * Integration with parallel-agent CHW Profile screen:
 *   ```tsx
 *   import { TestimonialsList } from '../../components/testimonials/TestimonialsList';
 *
 *   // Inside the CHW Profile screen render:
 *   <TestimonialsList chwId={chw.userId} limit={3} />
 *   ```
 *
 * The component is fully self-contained — it manages its own loading and
 * error state so the embedding screen does not need to wire any extra state.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Star } from 'lucide-react-native';

import {
  getTestimonialSummary,
  listChwTestimonials,
  type PublicTestimonial,
  type TestimonialSummary,
} from '../../api/testimonials';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';

// ─── Props ────────────────────────────────────────────────────────────────────

interface TestimonialsListProps {
  /** The CHW's user UUID. */
  chwId: string;
  /** Max testimonials to display inline. Defaults to 3. */
  limit?: number;
}

// ─── Star display helper ──────────────────────────────────────────────────────

interface StarRowProps {
  /** 0–5 (supports fractional values for the avg display). */
  value: number;
  size?: number;
}

function StarRow({ value, size = 14 }: StarRowProps): React.JSX.Element {
  return (
    <View style={starRowStyles.row} accessibilityLabel={`${value} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => {
        const starIndex = i + 1;
        const filled = starIndex <= Math.round(value);
        return (
          <Star
            key={starIndex}
            size={size}
            color={filled ? '#FBBF24' : colors.border}
            fill={filled ? '#FBBF24' : 'transparent'}
          />
        );
      })}
    </View>
  );
}

const starRowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
});

// ─── Testimonial card ─────────────────────────────────────────────────────────

interface TestimonialCardProps {
  testimonial: PublicTestimonial;
}

function TestimonialCard({ testimonial }: TestimonialCardProps): React.JSX.Element {
  const formattedDate = new Date(testimonial.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <View style={cardStyles.container}>
      <View style={cardStyles.header}>
        {/* Author avatar — initial displayed as a circle. */}
        <View style={cardStyles.avatar}>
          <Text style={cardStyles.avatarText}>{testimonial.authorInitial}</Text>
        </View>

        <View style={cardStyles.headerInfo}>
          <Text style={cardStyles.authorLabel}>{testimonial.authorInitial}</Text>
          <StarRow value={testimonial.rating} size={12} />
        </View>

        <Text style={cardStyles.date}>{formattedDate}</Text>
      </View>

      {testimonial.text ? (
        <Text style={cardStyles.body}>{testimonial.text}</Text>
      ) : null}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: `${colors.primary}18`,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarText: {
    fontFamily: 'PlusJakartaSans_700Bold',
    fontSize: 13,
    color: colors.primary,
  },
  headerInfo: {
    flex: 1,
    gap: 3,
  },
  authorLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: colors.foreground,
  },
  date: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: colors.mutedForeground,
  },
  body: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    lineHeight: 20,
    color: colors.foreground,
  },
});

// ─── Main component ───────────────────────────────────────────────────────────

export function TestimonialsList({
  chwId,
  limit = 3,
}: TestimonialsListProps): React.JSX.Element {
  const [summary, setSummary] = useState<TestimonialSummary | null>(null);
  const [testimonials, setTestimonials] = useState<PublicTestimonial[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Fire both requests; summary is cheap, list may be slightly heavier.
      const [summaryResult, listResult] = await Promise.all([
        getTestimonialSummary(chwId),
        listChwTestimonials(chwId, limit, 0),
      ]);
      setSummary(summaryResult);
      setTestimonials(listResult);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not load reviews.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [chwId, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} size="small" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity
          onPress={() => { void load(); }}
          style={styles.retryBtn}
          accessibilityRole="button"
          accessibilityLabel="Retry loading reviews"
        >
          <Text style={styles.retryBtnText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const hasRatings = summary !== null && summary.ratingCount > 0;

  return (
    <View style={styles.container}>
      {/* ── Section title ────────────────────────────────────────────── */}
      <Text style={styles.sectionTitle}>Reviews</Text>

      {/* ── Summary header ───────────────────────────────────────────── */}
      {hasRatings && summary ? (
        <View style={styles.summaryRow}>
          <StarRow value={summary.ratingAvg ?? 0} size={16} />
          <Text style={styles.avgText}>
            {summary.ratingAvg?.toFixed(1)}
          </Text>
          <Text style={styles.countText}>
            {summary.ratingCount === 1
              ? '1 review'
              : `${summary.ratingCount} reviews`}
          </Text>
        </View>
      ) : (
        /* ── Empty state ──────────────────────────────────────────────── */
        <View style={styles.emptyState}>
          <StarRow value={0} size={20} />
          <Text style={styles.emptyTitle}>No reviews yet</Text>
          <Text style={styles.emptySub}>
            Reviews from members will appear here after sessions.
          </Text>
        </View>
      )}

      {/* ── Testimonial cards ─────────────────────────────────────────── */}
      {testimonials.length > 0 && (
        <View style={styles.cardList}>
          {testimonials.map((t) => (
            <TestimonialCard key={t.id} testimonial={t} />
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  centered: {
    paddingVertical: 24,
    alignItems: 'center',
    gap: 10,
  },
  sectionTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: colors.foreground,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  avgText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: colors.foreground,
  },
  countText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: colors.mutedForeground,
  },
  emptyState: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 16,
  },
  emptyTitle: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: colors.mutedForeground,
  },
  emptySub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    lineHeight: 18,
    color: colors.mutedForeground,
    textAlign: 'center',
  },
  cardList: {
    gap: 10,
  },
  errorText: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  retryBtnText: {
    ...typography.bodySm,
    color: colors.primary,
    fontWeight: '600',
  },
});

/**
 * AdminTestimonialsScreen — admin moderation queue for member testimonials.
 *
 * Tabs: Pending | Approved | Rejected
 *
 * Each row shows:
 *   - Star rating (filled/empty stars)
 *   - Testimonial text (truncated, expandable in the review view)
 *   - Member full name + CHW name (for context)
 *   - Created date
 *   - Quick action buttons: Approve / Reject (on Pending rows)
 *
 * Approve/Reject flow:
 *   - Quick action buttons on the list card → immediate API call with no notes
 *   - Tap a card to open the review view where the admin can:
 *       - Read the full text
 *       - Add optional moderation notes
 *       - Approve or reject
 *
 * Auth: The admin key is read from the shared admin auth header.
 * This screen mirrors the AdminResourcesScreen pattern (no external router,
 * internal navigation state only, no React Query).
 *
 * The ADMIN_KEY is retrieved from AsyncStorage/SecureStore via the adminKey
 * prop injected by the parent AdminHomeScreen. If the parent doesn't inject it,
 * the screen falls back to the env var EXPO_PUBLIC_ADMIN_KEY (dev only).
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Check, ChevronLeft, X } from 'lucide-react-native';
import { Star } from 'lucide-react-native';

import {
  adminListTestimonials,
  adminModerateTestimonial,
  type AdminTestimonialView,
  type TestimonialStatus,
} from '../../api/testimonials';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';

// ─── Constants ────────────────────────────────────────────────────────────────

const ADMIN_KEY =
  process.env.EXPO_PUBLIC_ADMIN_KEY ?? '';

// ─── Types ────────────────────────────────────────────────────────────────────

type ActiveTab = TestimonialStatus;
type ScreenView = 'list' | { kind: 'review'; item: AdminTestimonialView };

interface AdminTestimonialsScreenProps {
  /** Optional injected admin key from the parent AdminHomeScreen. */
  adminKey?: string;
}

// ─── Star display helper ──────────────────────────────────────────────────────

interface MiniStarsProps {
  rating: number;
}

function MiniStars({ rating }: MiniStarsProps): React.JSX.Element {
  return (
    <View style={miniStarStyles.row} accessibilityLabel={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => {
        const filled = i + 1 <= rating;
        return (
          <Star
            key={i}
            size={12}
            color={filled ? '#FBBF24' : colors.border}
            fill={filled ? '#FBBF24' : 'transparent'}
          />
        );
      })}
    </View>
  );
}

const miniStarStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 2,
  },
});

// ─── Testimonial row card ─────────────────────────────────────────────────────

interface TestimonialRowProps {
  item: AdminTestimonialView;
  onOpenReview: (item: AdminTestimonialView) => void;
  onApprove: (item: AdminTestimonialView) => void;
  onReject: (item: AdminTestimonialView) => void;
}

function TestimonialRow({
  item,
  onOpenReview,
  onApprove,
  onReject,
}: TestimonialRowProps): React.JSX.Element {
  const isPending = item.status === 'pending';
  const formattedDate = new Date(item.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <TouchableOpacity
      style={rowStyles.container}
      onPress={() => onOpenReview(item)}
      accessibilityRole="button"
      accessibilityLabel={`Review testimonial from ${item.memberName} for ${item.chwName}`}
    >
      <View style={rowStyles.body}>
        {/* Rating + meta row */}
        <View style={rowStyles.metaRow}>
          <MiniStars rating={item.rating} />
          <Text style={rowStyles.date}>{formattedDate}</Text>
        </View>

        {/* Testimonial text (truncated) */}
        {item.text ? (
          <Text style={rowStyles.text} numberOfLines={2}>
            {item.text}
          </Text>
        ) : (
          <Text style={rowStyles.noText}>No text provided</Text>
        )}

        {/* Participant names */}
        <Text style={rowStyles.names}>
          <Text style={rowStyles.nameLabel}>Member: </Text>
          {item.memberName}
          {'  '}
          <Text style={rowStyles.nameLabel}>CHW: </Text>
          {item.chwName}
        </Text>

        {/* Moderation notes (if any) */}
        {item.moderationNotes ? (
          <Text style={rowStyles.moderationNote} numberOfLines={1}>
            Note: {item.moderationNotes}
          </Text>
        ) : null}
      </View>

      {/* Quick action buttons — visible on pending items only */}
      {isPending && (
        <View style={rowStyles.actions}>
          <TouchableOpacity
            style={rowStyles.approveBtn}
            onPress={() => onApprove(item)}
            accessibilityRole="button"
            accessibilityLabel="Approve testimonial"
            hitSlop={6}
          >
            <Check size={16} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={rowStyles.rejectBtn}
            onPress={() => onReject(item)}
            accessibilityRole="button"
            accessibilityLabel="Reject testimonial"
            hitSlop={6}
          >
            <X size={16} color="#fff" />
          </TouchableOpacity>
        </View>
      )}
    </TouchableOpacity>
  );
}

const rowStyles = StyleSheet.create({
  container: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  body: {
    flex: 1,
    gap: 5,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  date: {
    ...typography.label,
    color: colors.mutedForeground,
  },
  text: {
    ...typography.bodySm,
    color: colors.foreground,
    lineHeight: 18,
  },
  noText: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    fontStyle: 'italic',
  },
  names: {
    ...typography.label,
    color: colors.mutedForeground,
    lineHeight: 16,
  },
  nameLabel: {
    fontWeight: '700',
    color: colors.foreground,
  },
  moderationNote: {
    ...typography.label,
    color: colors.secondary,
    fontStyle: 'italic',
  },
  actions: {
    flexDirection: 'column',
    gap: 8,
    flexShrink: 0,
  },
  approveBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#10B981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: colors.destructive,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

// ─── Main screen ──────────────────────────────────────────────────────────────

export function AdminTestimonialsScreen({
  adminKey: injectedKey,
}: AdminTestimonialsScreenProps): React.JSX.Element {
  const key = injectedKey ?? ADMIN_KEY;

  const [activeTab, setActiveTab] = useState<ActiveTab>('pending');
  const [view, setView] = useState<ScreenView>('list');
  const [items, setItems] = useState<AdminTestimonialView[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Review-view state.
  const [moderationNotes, setModerationNotes] = useState('');
  const [isActing, setIsActing] = useState(false);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchItems = useCallback(
    async (status: ActiveTab) => {
      setIsLoading(true);
      try {
        const data = await adminListTestimonials(status, 50, 0, key);
        setItems(data);
      } catch (err: unknown) {
        Alert.alert('Error', err instanceof Error ? err.message : 'Failed to load');
      } finally {
        setIsLoading(false);
      }
    },
    [key],
  );

  useEffect(() => {
    void fetchItems(activeTab);
  }, [activeTab, fetchItems]);

  // ── Quick-action handlers (from the list row buttons) ──────────────────────

  const handleQuickApprove = useCallback(
    (item: AdminTestimonialView) => {
      Alert.alert(
        'Approve testimonial?',
        `Rating: ${item.rating}/5${item.text ? `\n"${item.text.slice(0, 80)}${item.text.length > 80 ? '…' : ''}"` : ''}`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Approve',
            style: 'default',
            onPress: async () => {
              try {
                await adminModerateTestimonial(item.id, { action: 'approve' }, key);
                void fetchItems(activeTab);
              } catch (err: unknown) {
                Alert.alert('Error', err instanceof Error ? err.message : 'Approve failed');
              }
            },
          },
        ],
      );
    },
    [key, fetchItems, activeTab],
  );

  const handleQuickReject = useCallback(
    (item: AdminTestimonialView) => {
      Alert.alert(
        'Reject testimonial?',
        `Rating: ${item.rating}/5 — from ${item.memberName}`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Reject',
            style: 'destructive',
            onPress: async () => {
              try {
                await adminModerateTestimonial(item.id, { action: 'reject' }, key);
                void fetchItems(activeTab);
              } catch (err: unknown) {
                Alert.alert('Error', err instanceof Error ? err.message : 'Reject failed');
              }
            },
          },
        ],
      );
    },
    [key, fetchItems, activeTab],
  );

  // ── Review-view actions ────────────────────────────────────────────────────

  const openReview = useCallback((item: AdminTestimonialView) => {
    setModerationNotes('');
    setView({ kind: 'review', item });
  }, []);

  const handleModerate = useCallback(
    async (action: 'approve' | 'reject') => {
      if (view === 'list') return;
      setIsActing(true);
      try {
        await adminModerateTestimonial(
          view.item.id,
          { action, notes: moderationNotes.trim() || null },
          key,
        );
        setView('list');
        void fetchItems(activeTab);
      } catch (err: unknown) {
        Alert.alert('Error', err instanceof Error ? err.message : `${action} failed`);
      } finally {
        setIsActing(false);
      }
    },
    [view, moderationNotes, key, fetchItems, activeTab],
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  const TABS: Array<{ key: ActiveTab; label: string }> = [
    { key: 'pending', label: 'Pending' },
    { key: 'approved', label: 'Approved' },
    { key: 'rejected', label: 'Rejected' },
  ];

  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <View style={s.header}>
        <Text style={s.title}>Testimonials</Text>
      </View>

      {/* ── Tab bar ─────────────────────────────────────────────────────── */}
      <View style={s.tabBar}>
        {TABS.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[s.tab, activeTab === tab.key && s.tabActive]}
            onPress={() => {
              setActiveTab(tab.key);
              setView('list');
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === tab.key }}
          >
            <Text style={[s.tabLabel, activeTab === tab.key && s.tabLabelActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── List view ───────────────────────────────────────────────────── */}
      {view === 'list' && (
        <View style={s.content}>
          {isLoading ? (
            <ActivityIndicator style={s.loader} color={colors.primary} />
          ) : (
            <ScrollView contentContainerStyle={s.listContent}>
              {items.map((item) => (
                <TestimonialRow
                  key={item.id}
                  item={item}
                  onOpenReview={openReview}
                  onApprove={handleQuickApprove}
                  onReject={handleQuickReject}
                />
              ))}
              {items.length === 0 && !isLoading && (
                <Text style={s.emptyLabel}>
                  No {activeTab} testimonials.
                </Text>
              )}
            </ScrollView>
          )}
        </View>
      )}

      {/* ── Review view ─────────────────────────────────────────────────── */}
      {view !== 'list' && (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={s.content}
        >
          <TouchableOpacity
            style={s.backRow}
            onPress={() => setView('list')}
            accessibilityRole="button"
          >
            <ChevronLeft size={20} color={colors.primary} />
            <Text style={s.backLabel}>Back to queue</Text>
          </TouchableOpacity>

          <ScrollView contentContainerStyle={s.reviewContent}>
            {/* Rating */}
            <View style={s.reviewRatingRow}>
              <MiniStars rating={view.item.rating} />
              <Text style={s.reviewRatingText}>{view.item.rating}/5</Text>
            </View>

            {/* Participants */}
            <View style={s.reviewSection}>
              <Text style={s.reviewSectionTitle}>Participants</Text>
              <Text style={s.reviewBody}>
                <Text style={s.reviewKey}>Member: </Text>
                {view.item.memberName}
              </Text>
              <Text style={s.reviewBody}>
                <Text style={s.reviewKey}>CHW: </Text>
                {view.item.chwName}
              </Text>
              <Text style={s.reviewBody}>
                <Text style={s.reviewKey}>Submitted: </Text>
                {new Date(view.item.createdAt).toLocaleString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </Text>
            </View>

            {/* Full text */}
            <View style={s.reviewSection}>
              <Text style={s.reviewSectionTitle}>Review Text</Text>
              {view.item.text ? (
                <Text style={s.reviewBody} selectable>
                  {view.item.text}
                </Text>
              ) : (
                <Text style={[s.reviewBody, { fontStyle: 'italic', color: colors.mutedForeground }]}>
                  No text provided.
                </Text>
              )}
            </View>

            {/* Current status */}
            <View style={s.reviewSection}>
              <Text style={s.reviewSectionTitle}>Current Status</Text>
              <Text style={[s.reviewBody, { textTransform: 'capitalize' }]}>
                {view.item.status}
              </Text>
            </View>

            {/* Admin notes input */}
            <View style={s.reviewSection}>
              <Text style={s.reviewSectionTitle}>Moderation Notes (optional)</Text>
              <TextInput
                value={moderationNotes}
                onChangeText={setModerationNotes}
                placeholder="Add a note visible only to admins…"
                placeholderTextColor={colors.mutedForeground}
                multiline
                numberOfLines={3}
                maxLength={1000}
                style={s.notesInput}
                textAlignVertical="top"
                editable={!isActing}
              />
            </View>
          </ScrollView>

          {/* Action buttons */}
          <View style={s.reviewActions}>
            <TouchableOpacity
              style={s.rejectBtnLg}
              onPress={() => void handleModerate('reject')}
              disabled={isActing}
              accessibilityRole="button"
            >
              {isActing ? (
                <ActivityIndicator size="small" color={colors.destructive} />
              ) : (
                <Text style={s.rejectLabel}>Reject</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={s.approveBtnLg}
              onPress={() => void handleModerate('approve')}
              disabled={isActing}
              accessibilityRole="button"
            >
              {isActing ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={s.approveLabel}>Approve</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    ...typography.displaySm,
    color: colors.foreground,
  },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: colors.primary,
  },
  tabLabel: {
    ...typography.bodySm,
    color: colors.mutedForeground,
  },
  tabLabelActive: {
    color: colors.primary,
    fontWeight: '700',
  },
  content: {
    flex: 1,
  },
  loader: {
    marginTop: 40,
  },
  listContent: {
    padding: 16,
    gap: 10,
  },
  emptyLabel: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    textAlign: 'center',
    marginTop: 40,
  },
  // ── Back row ──────────────────────────────────────────────────────────
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 4,
  },
  backLabel: {
    ...typography.bodySm,
    color: colors.primary,
    fontWeight: '600',
  },
  // ── Review view ───────────────────────────────────────────────────────
  reviewContent: {
    padding: 20,
    gap: 20,
  },
  reviewRatingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  reviewRatingText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: colors.foreground,
  },
  reviewSection: {
    gap: 6,
  },
  reviewSectionTitle: {
    ...typography.label,
    color: colors.mutedForeground,
    textTransform: 'uppercase',
  },
  reviewBody: {
    ...typography.bodySm,
    color: colors.foreground,
    lineHeight: 20,
  },
  reviewKey: {
    fontWeight: '700',
  },
  notesInput: {
    backgroundColor: colors.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...typography.bodySm,
    color: colors.foreground,
    minHeight: 80,
  },
  reviewActions: {
    flexDirection: 'row',
    gap: 10,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  rejectBtnLg: {
    flex: 1,
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.destructive,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectLabel: {
    ...typography.bodySm,
    fontWeight: '700',
    color: colors.destructive,
  },
  approveBtnLg: {
    flex: 2,
    height: 48,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approveLabel: {
    ...typography.bodySm,
    fontWeight: '700',
    color: '#fff',
  },
});

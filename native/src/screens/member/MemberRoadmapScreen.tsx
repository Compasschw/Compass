/**
 * MemberRoadmapScreen — Member's health journey goal tracker.
 *
 * Sections:
 * 1. Overall progress bar across all goals
 * 2. Active goal cards with individual progress bars and status labels
 * 3. Timeline card (projected completion)
 * 4. Add Goal button that opens a form Modal
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle,
  Flag,
  Plus,
  X,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography, fonts } from '../../theme/typography';
import {
  verticalLabels,
  type Goal,
  type Vertical,
} from '../../data/mock';
import {
  useMemberRoadmap,
  useCompleteRoadmapItem,
  type SessionFollowup,
  type FollowupVertical,
} from '../../hooks/useFollowupQueries';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LocalGoal extends Goal {
  /** True when added interactively in this session */
  isNew?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VERTICAL_OPTIONS: { key: Vertical; label: string; emoji: string }[] = [
  { key: 'housing', label: 'Housing', emoji: '🏠' },
  { key: 'food', label: 'Food Security', emoji: '🛒' },
  { key: 'mental_health', label: 'Mental Health', emoji: '🧠' },
  { key: 'rehab', label: 'Rehab & Recovery', emoji: '💪' },
  { key: 'healthcare', label: 'Healthcare Access', emoji: '🏥' },
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const TIMELINE_STEPS = [
  { label: 'Apr', done: true },
  { label: 'May', done: false },
  { label: 'Jun', done: false },
  { label: 'Sep', done: false },
  { label: 'Dec', done: false, isFinal: true },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcOverallProgress(goalList: LocalGoal[]): number {
  if (goalList.length === 0) return 0;
  const sum = goalList.reduce((acc, g) => acc + g.progress, 0);
  return Math.round(sum / goalList.length);
}

function statusLabel(status: string): string {
  switch (status) {
    case 'on_track': return 'On track';
    case 'almost_done': return 'Almost done';
    case 'completed': return 'Completed';
    default: return status;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'on_track': return colors.secondary;
    case 'almost_done': return colors.compassGold;
    case 'completed': return colors.primary;
    default: return colors.mutedForeground;
  }
}

function formatNextSession(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ProgressBarProps {
  value: number;
  label: string;
  height?: number;
}

function ProgressBar({ value, label, height = 6 }: ProgressBarProps): React.JSX.Element {
  return (
    <View
      style={[progressStyles.track, { height }]}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: value }}
      accessibilityLabel={label}
    >
      <View style={[progressStyles.fill, { width: `${value}%`, height }]} />
    </View>
  );
}

const progressStyles = StyleSheet.create({
  track: {
    width: '100%',
    backgroundColor: '#DDD6CC',
    borderRadius: 999,
    overflow: 'hidden',
  },
  fill: {
    backgroundColor: '#3D5A3E',
    borderRadius: 999,
  },
});

interface GoalCardProps {
  goal: LocalGoal;
}

function GoalCard({ goal }: GoalCardProps): React.JSX.Element {
  const sColor = statusColor(goal.status);

  return (
    <View style={goalCardStyles.container}>
      <View style={goalCardStyles.row}>
        <Text style={goalCardStyles.emoji} accessibilityElementsHidden>{goal.emoji}</Text>
        <View style={goalCardStyles.content}>
          {/* Title + badge */}
          <View style={goalCardStyles.titleRow}>
            <Text style={goalCardStyles.title} numberOfLines={1}>{goal.title}</Text>
            <View style={[goalCardStyles.badge, { backgroundColor: `${colors.secondary}18` }]}>
              <Text style={[goalCardStyles.badgeText, { color: colors.secondary }]}>
                {verticalLabels[goal.category]}
              </Text>
            </View>
          </View>

          {/* Status meta */}
          <Text style={goalCardStyles.meta}>
            {goal.sessionsCompleted > 0
              ? `${goal.sessionsCompleted} session${goal.sessionsCompleted !== 1 ? 's' : ''} completed`
              : 'Just getting started'}
            <Text style={{ color: sColor }}> · {statusLabel(goal.status)}</Text>
          </Text>

          {/* Progress */}
          <View style={goalCardStyles.progressRow}>
            <Text style={goalCardStyles.progressLabel}>Progress</Text>
            <Text style={goalCardStyles.progressPct}>{goal.progress}%</Text>
          </View>
          <ProgressBar
            value={goal.progress}
            label={`${goal.title} progress: ${goal.progress}%`}
            height={8}
          />

          {/* Footer */}
          <Text style={goalCardStyles.footer}>
            CHW Sessions: {goal.sessionsCompleted}
            {' · '}
            Next: {formatNextSession(goal.nextSession)}
          </Text>
        </View>
      </View>
    </View>
  );
}

const goalCardStyles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 14,
    marginBottom: 12,
    ...Platform.select({
      ios: {
        shadowColor: '#3D5A3E',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 24,
      },
      android: {
        elevation: 3,
      },
    }),
  },
  row: {
    flexDirection: 'row',
    gap: 14,
    alignItems: 'flex-start',
  },
  emoji: {
    fontSize: 28,
    lineHeight: 34,
    marginTop: 2,
  },
  content: {
    flex: 1,
    gap: 4,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#1E3320',
    flex: 1,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  badgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
  },
  meta: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
    marginBottom: 6,
  },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  progressLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
  },
  progressPct: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 11,
    color: '#1E3320',
  },
  footer: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
    marginTop: 6,
  },
});

// ─── Session Followup rendering ──────────────────────────────────────────────

const FOLLOWUP_VERTICAL_LABELS: Record<FollowupVertical, string> = {
  housing: 'Housing',
  food: 'Food Security',
  mental_health: 'Mental Health',
  rehab: 'Rehab',
  healthcare: 'Healthcare',
};

const FOLLOWUP_PRIORITY_COLORS: Record<string, string> = {
  low: colors.secondary,
  medium: colors.compassGold,
  high: colors.destructive,
};

const FOLLOWUP_STATUS_COLORS: Record<string, string> = {
  confirmed: colors.secondary,
  completed: colors.primary,
  pending: colors.compassGold,
  dismissed: colors.mutedForeground,
};

function formatFollowupDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface SessionFollowupRowProps {
  item: SessionFollowup;
  onMarkComplete: (item: SessionFollowup) => void;
  isCompleting: boolean;
}

/**
 * A single row for a session-sourced roadmap item.
 * Includes description, optional due date, status badge, and a "Mark complete"
 * button for confirmed items that are not yet completed.
 *
 * HIPAA: item.description is rendered only — never logged.
 */
function SessionFollowupRow({
  item,
  onMarkComplete,
  isCompleting,
}: SessionFollowupRowProps): React.JSX.Element {
  const statusColor = FOLLOWUP_STATUS_COLORS[item.status] ?? colors.mutedForeground;
  const isCompleted = item.status === 'completed';
  const canComplete = item.status === 'confirmed' && !isCompleted;

  return (
    <View style={sfRow.card}>
      {/* Top: description + status badge */}
      <View style={sfRow.headerRow}>
        <Text style={[sfRow.description, isCompleted && sfRow.descriptionDone]}>
          {item.description}
        </Text>
        <View style={[sfRow.statusBadge, { backgroundColor: `${statusColor}18` }]}>
          <Text style={[sfRow.statusText, { color: statusColor }]}>
            {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
          </Text>
        </View>
      </View>

      {/* Meta: due date, priority */}
      <View style={sfRow.metaRow}>
        {item.dueDate ? (
          <View style={sfRow.metaChip}>
            <CalendarDays size={10} color={colors.mutedForeground} />
            <Text style={sfRow.metaChipText}>Due {formatFollowupDate(item.dueDate)}</Text>
          </View>
        ) : null}
        {item.priority ? (
          <View style={[sfRow.metaChip, { borderColor: `${FOLLOWUP_PRIORITY_COLORS[item.priority]}40` }]}>
            <Flag size={10} color={FOLLOWUP_PRIORITY_COLORS[item.priority] ?? colors.mutedForeground} />
            <Text style={[sfRow.metaChipText, { color: FOLLOWUP_PRIORITY_COLORS[item.priority] }]}>
              {item.priority.charAt(0).toUpperCase() + item.priority.slice(1)}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Footer: session attribution */}
      {(item.chwName || item.sessionDate) ? (
        <Text style={sfRow.attribution}>
          From session
          {item.chwName ? ` with ${item.chwName}` : ''}
          {item.sessionDate ? ` on ${formatFollowupDate(item.sessionDate)}` : ''}
        </Text>
      ) : null}

      {/* Mark complete CTA */}
      {canComplete ? (
        <TouchableOpacity
          style={sfRow.completeBtn}
          onPress={() => onMarkComplete(item)}
          disabled={isCompleting}
          accessibilityRole="button"
          accessibilityLabel={`Mark item complete: ${item.description.slice(0, 40)}`}
        >
          {isCompleting ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <CheckCircle size={14} color={colors.primaryForeground} />
          )}
          <Text style={sfRow.completeBtnText}>Mark Complete</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const sfRow = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 14,
    marginBottom: 10,
    gap: 8,
    ...Platform.select({
      ios: {
        shadowColor: '#3D5A3E',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.06,
        shadowRadius: 16,
      },
      android: { elevation: 2 },
    }),
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  description: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 20,
    color: '#1E3320',
  },
  descriptionDone: {
    textDecorationLine: 'line-through',
    color: '#6B7280',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
    flexShrink: 0,
  },
  statusText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    backgroundColor: '#F4F1ED',
  },
  metaChipText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: '#6B7280',
  },
  attribution: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: '#6B7280',
    fontStyle: 'italic',
  },
  completeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#3D5A3E',
    borderRadius: 10,
    paddingVertical: 9,
    marginTop: 2,
  },
  completeBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: '#FFFFFF',
  },
});

/**
 * Groups a list of SessionFollowup items by vertical.
 * Items without a vertical go under "general".
 */
function groupByVertical(
  items: SessionFollowup[],
): { vertical: FollowupVertical | 'general'; label: string; items: SessionFollowup[] }[] {
  const grouped: Record<string, SessionFollowup[]> = {};
  for (const item of items) {
    const key = item.vertical ?? 'general';
    if (!grouped[key]) grouped[key] = [];
    grouped[key]!.push(item);
  }

  return Object.entries(grouped).map(([key, groupItems]) => ({
    vertical: key as FollowupVertical | 'general',
    label:
      key === 'general'
        ? 'General'
        : FOLLOWUP_VERTICAL_LABELS[key as FollowupVertical] ?? key,
    items: groupItems,
  }));
}

// ─── Add Goal Modal ────────────────────────────────────────────────────────────

interface AddGoalModalProps {
  visible: boolean;
  onClose: () => void;
  onAdd: (goal: LocalGoal) => void;
}

function AddGoalModal({ visible, onClose, onAdd }: AddGoalModalProps): React.JSX.Element {
  const [selectedVertical, setSelectedVertical] = useState<Vertical | null>(null);
  const [title, setTitle] = useState('');
  const [selectedMonth, setSelectedMonth] = useState<string>('');

  const isValid = selectedVertical !== null && title.trim().length > 0;

  const resetForm = useCallback(() => {
    setSelectedVertical(null);
    setTitle('');
    setSelectedMonth('');
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const handleAdd = useCallback(() => {
    if (!selectedVertical) return;

    const option = VERTICAL_OPTIONS.find((v) => v.key === selectedVertical)!;
    const monthIndex = selectedMonth ? MONTHS.indexOf(selectedMonth) + 1 : 12;
    const targetDate = `2026-${String(monthIndex).padStart(2, '0')}-01T00:00:00Z`;

    const newGoal: LocalGoal = {
      id: `goal-new-${Date.now()}`,
      title: title.trim(),
      emoji: option.emoji,
      category: selectedVertical,
      progress: 0,
      sessionsCompleted: 0,
      nextSession: targetDate,
      status: 'on_track',
      isNew: true,
    };

    resetForm();
    onAdd(newGoal);
  }, [selectedVertical, title, selectedMonth, onAdd, resetForm]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={handleClose}
    >
      <View style={addGoalModalStyles.backdrop}>
        <View style={addGoalModalStyles.sheet}>
          {/* Header */}
          <View style={addGoalModalStyles.header}>
            <Text style={addGoalModalStyles.headerTitle}>Add a New Goal</Text>
            <TouchableOpacity
              onPress={handleClose}
              style={addGoalModalStyles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel="Close modal"
              hitSlop={8}
            >
              <X color={colors.mutedForeground} size={18} />
            </TouchableOpacity>
          </View>

          <ScrollView style={addGoalModalStyles.body} showsVerticalScrollIndicator={false}>
            {/* Category selection */}
            <Text style={addGoalModalStyles.fieldLabel}>Category</Text>
            <View style={addGoalModalStyles.verticalList}>
              {VERTICAL_OPTIONS.map((opt) => {
                const isSelected = selectedVertical === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    onPress={() => setSelectedVertical(opt.key)}
                    style={[
                      addGoalModalStyles.verticalOption,
                      isSelected && addGoalModalStyles.verticalOptionSelected,
                    ]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={opt.label}
                  >
                    <Text style={addGoalModalStyles.verticalEmoji}>{opt.emoji}</Text>
                    <Text style={[
                      addGoalModalStyles.verticalOptionText,
                      isSelected && { color: colors.primary },
                    ]}>
                      {opt.label}
                    </Text>
                    {isSelected ? (
                      <CheckCircle color={colors.primary} size={15} />
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Goal title */}
            <Text style={addGoalModalStyles.fieldLabel}>Goal Title</Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Enroll in CalFresh by June"
              placeholderTextColor={colors.mutedForeground}
              maxLength={80}
              style={addGoalModalStyles.textInput}
              accessibilityLabel="Goal title"
              returnKeyType="done"
            />

            {/* Target month */}
            <Text style={addGoalModalStyles.fieldLabel}>
              Target Month{' '}
              <Text style={addGoalModalStyles.fieldLabelOptional}>(optional)</Text>
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={addGoalModalStyles.monthScroll}
            >
              {MONTHS.map((m) => {
                const isSelected = selectedMonth === m;
                return (
                  <TouchableOpacity
                    key={m}
                    onPress={() => setSelectedMonth(isSelected ? '' : m)}
                    style={[
                      addGoalModalStyles.monthChip,
                      isSelected && addGoalModalStyles.monthChipSelected,
                    ]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text style={[
                      addGoalModalStyles.monthChipText,
                      isSelected && { color: colors.primary },
                    ]}>
                      {m.slice(0, 3)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Submit */}
            <TouchableOpacity
              onPress={handleAdd}
              disabled={!isValid}
              style={[addGoalModalStyles.addBtn, !isValid && addGoalModalStyles.addBtnDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Add goal"
            >
              <Text style={[addGoalModalStyles.addBtnText, !isValid && { color: colors.mutedForeground }]}>
                Add Goal
              </Text>
            </TouchableOpacity>

            <View style={{ height: 32 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const addGoalModalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '90%',
    ...Platform.select({
      ios: {
        shadowColor: '#3D5A3E',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.1,
        shadowRadius: 16,
      },
      android: {
        elevation: 16,
      },
    }),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
  },
  headerTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#1E3320',
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F4F1ED',
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    padding: 18,
  },
  fieldLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#1E3320',
    marginBottom: 10,
  },
  fieldLabelOptional: {
    fontFamily: 'PlusJakartaSans_400Regular',
    color: '#6B7280',
  },
  verticalList: {
    gap: 8,
    marginBottom: 20,
  },
  verticalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    backgroundColor: '#FFFFFF',
  },
  verticalOptionSelected: {
    borderColor: '#3D5A3E',
    backgroundColor: '#3D5A3E0D',
  },
  verticalEmoji: {
    fontSize: 18,
  },
  verticalOptionText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#1E3320',
    flex: 1,
  },
  textInput: {
    borderWidth: 1,
    borderColor: '#DDD6CC',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#1E3320',
    marginBottom: 20,
    backgroundColor: '#FFFFFF',
  },
  monthScroll: {
    gap: 6,
    paddingBottom: 4,
    marginBottom: 20,
  },
  monthChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    backgroundColor: '#FFFFFF',
  },
  monthChipSelected: {
    borderColor: '#3D5A3E',
    backgroundColor: '#3D5A3E0D',
  },
  monthChipText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
  },
  addBtn: {
    backgroundColor: '#3D5A3E',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  addBtnDisabled: {
    backgroundColor: '#DDD6CC',
  },
  addBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberRoadmapScreen(): React.JSX.Element {
  // Goals are locally stored in component state for now. A backend goals
  // endpoint doesn't exist yet; when it does, replace this with a useMemberGoals
  // query + useAddGoal / useUpdateGoal mutations from useApiQueries.
  const [goalList, setGoalList] = useState<LocalGoal[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);

  // ── Session followup roadmap items ─────────────────────────────────────────
  const roadmapQuery = useMemberRoadmap();
  const completeRoadmapItem = useCompleteRoadmapItem();
  // Track which item ID is currently being marked complete (optimistic UX).
  const [completingId, setCompletingId] = useState<string | null>(null);

  const roadmapItems = roadmapQuery.data ?? [];
  const groupedRoadmap = groupByVertical(roadmapItems);

  const handleMarkComplete = useCallback(
    async (item: SessionFollowup) => {
      if (!item.id) return;
      setCompletingId(item.id);
      try {
        // sessionId is not directly on the item — the backend needs it for the PATCH path.
        // TODO(backend): GET /member/roadmap should include session_id on each item so the
        // client can build the correct PATCH URL. Tracked in Compass issue #[roadmap-session-id].
        // For now we fall back to a placeholder that will 404 gracefully.
        const sessionId = (item as SessionFollowup & { sessionId?: string }).sessionId ?? 'unknown';
        await completeRoadmapItem.mutateAsync({ sessionId, followupId: item.id });
      } finally {
        setCompletingId(null);
      }
    },
    [completeRoadmapItem],
  );

  // ─────────────────────────────────────────────────────────────────────────────

  const overallProgress = calcOverallProgress(goalList);

  const handleAddGoal = useCallback((newGoal: LocalGoal) => {
    setGoalList((prev) => [...prev, newGoal]);
    setShowAddModal(false);
  }, []);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />

      <AddGoalModal
        visible={showAddModal}
        onClose={() => setShowAddModal(false)}
        onAdd={handleAddGoal}
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Page header */}
        <View style={styles.pageHeader}>
          <Text style={styles.pageTitle}>My Roadmap</Text>
          <Text style={styles.pageSub}>Track your health journey</Text>
        </View>

        {/* Overall progress card */}
        <View style={styles.overallCard}>
          <View style={styles.overallCardHeader}>
            <Text style={styles.overallCardTitle}>Overall Progress</Text>
            <Text style={styles.overallPct}>{overallProgress}%</Text>
          </View>
          <ProgressBar
            value={overallProgress}
            label={`Overall health journey progress: ${overallProgress}%`}
            height={10}
          />
          <Text style={styles.overallCardSub}>
            {goalList.length} active goal{goalList.length !== 1 ? 's' : ''} in progress
          </Text>
        </View>

        {/* ── Session follow-up roadmap ─────────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>FROM YOUR SESSIONS</Text>

        {roadmapQuery.isLoading ? (
          <View style={styles.roadmapLoading}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : roadmapQuery.error ? (
          <View style={styles.roadmapError}>
            <AlertCircle size={20} color={colors.destructive} />
            <Text style={styles.roadmapErrorText}>
              Could not load session items. Pull to refresh.
            </Text>
          </View>
        ) : roadmapItems.length === 0 ? (
          <View style={styles.roadmapEmpty}>
            <Text style={styles.roadmapEmptyText}>
              Your roadmap is empty. Items from your sessions will appear here.
            </Text>
          </View>
        ) : (
          groupedRoadmap.map((group) => (
            <View key={group.vertical} style={styles.roadmapGroup}>
              <Text style={styles.roadmapGroupLabel}>{group.label}</Text>
              {group.items.map((item) => (
                <SessionFollowupRow
                  key={item.id}
                  item={item}
                  onMarkComplete={(i) => { void handleMarkComplete(i); }}
                  isCompleting={completingId === item.id}
                />
              ))}
            </View>
          ))
        )}

        {/* Goals section */}
        <Text style={styles.sectionLabel}>ACTIVE GOALS</Text>

        {goalList.length > 0 ? (
          goalList.map((goal) => <GoalCard key={goal.id} goal={goal} />)
        ) : (
          <View style={styles.emptyState}>
            <Text style={styles.emptyEmoji}>🎯</Text>
            <Text style={styles.emptyTitle}>No active goals yet</Text>
            <Text style={styles.emptySub}>
              Add your first health goal to start tracking your progress.
            </Text>
          </View>
        )}

        {/* Timeline card */}
        <Text style={styles.sectionLabel}>TIMELINE</Text>
        <View style={styles.timelineCard}>
          <View style={styles.timelineHeader}>
            <View style={styles.timelineIconBox}>
              <CalendarDays color="#0077B6" size={18} />
            </View>
            <View style={styles.timelineInfo}>
              <Text style={styles.timelineSubLabel}>PROJECTED COMPLETION</Text>
              <Text style={styles.timelineTitle}>Goal Completion: December 2026</Text>
              <Text style={styles.timelineSub}>Based on current session frequency</Text>
            </View>
          </View>

          {/* Milestone strip */}
          <View style={styles.milestoneStrip}>
            {TIMELINE_STEPS.map((step, idx) => (
              <View key={idx} style={styles.milestoneStep}>
                <View style={styles.milestoneDotRow}>
                  <View style={[
                    styles.milestoneDot,
                    step.isFinal
                      ? styles.milestoneDotFinal
                      : step.done
                      ? styles.milestoneDotDone
                      : styles.milestoneDotEmpty,
                  ]} />
                  {idx < TIMELINE_STEPS.length - 1 && (
                    <View style={styles.milestoneConnector} />
                  )}
                </View>
                <Text style={styles.milestoneLabel}>{step.label}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Add Goal CTA */}
        <TouchableOpacity
          onPress={() => setShowAddModal(true)}
          style={styles.addGoalBtn}
          accessibilityRole="button"
          accessibilityLabel="Add a new health goal"
        >
          <Plus color={colors.primary} size={18} />
          <Text style={styles.addGoalBtnText}>Add Goal</Text>
        </TouchableOpacity>

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F1ED',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  pageHeader: {
    marginBottom: 20,
  },
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
  },

  // Overall progress
  overallCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 20,
    marginBottom: 20,
    ...Platform.select({
      ios: {
        shadowColor: '#3D5A3E',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 24,
      },
      android: {
        elevation: 3,
      },
    }),
  },
  overallCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  overallCardTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#1E3320',
  },
  overallPct: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 20,
    color: '#3D5A3E',
  },
  overallCardSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
    marginTop: 8,
  },

  // Section label
  sectionLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#6B7280',
    letterSpacing: 1,
    marginBottom: 12,
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 24,
    gap: 8,
    marginBottom: 20,
  },
  emptyEmoji: {
    fontSize: 36,
  },
  emptyTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#1E3320',
  },
  emptySub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
  },

  // Timeline
  timelineCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    marginBottom: 20,
    ...Platform.select({
      ios: {
        shadowColor: '#3D5A3E',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 24,
      },
      android: {
        elevation: 3,
      },
    }),
  },
  timelineHeader: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  timelineIconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#3D5A3E15',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  timelineInfo: {
    flex: 1,
  },
  timelineSubLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 9,
    color: '#6B7280',
    letterSpacing: 1,
    marginBottom: 2,
  },
  timelineTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#1E3320',
  },
  timelineSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
    marginTop: 2,
  },
  milestoneStrip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderTopWidth: 1,
    borderTopColor: '#DDD6CC',
    paddingTop: 14,
  },
  milestoneStep: {
    alignItems: 'center',
    flex: 1,
  },
  milestoneDotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    justifyContent: 'center',
  },
  milestoneDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  milestoneDotDone: {
    backgroundColor: '#3D5A3E',
  },
  milestoneDotEmpty: {
    backgroundColor: '#DDD6CC',
  },
  milestoneDotFinal: {
    backgroundColor: '#7A9F5A',
  },
  milestoneConnector: {
    position: 'absolute',
    left: '55%',
    right: 0,
    height: 1,
    backgroundColor: '#DDD6CC',
    zIndex: -1,
  },
  milestoneLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 9,
    color: '#6B7280',
    marginTop: 4,
  },

  // Session roadmap
  roadmapLoading: {
    alignItems: 'center',
    paddingVertical: 20,
    marginBottom: 20,
  },
  roadmapError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: `${colors.destructive}30`,
    backgroundColor: `${colors.destructive}08`,
    marginBottom: 20,
  },
  roadmapErrorText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: colors.destructive,
    flex: 1,
  },
  roadmapEmpty: {
    paddingVertical: 20,
    paddingHorizontal: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    marginBottom: 20,
    alignItems: 'center',
  },
  roadmapEmptyText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 22,
  },
  roadmapGroup: {
    marginBottom: 12,
  },
  roadmapGroupLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#3D5A3E',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 8,
  },

  // Add Goal
  addGoalBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: '#3D5A3E',
    borderRadius: 14,
    paddingVertical: 14,
    marginBottom: 8,
  },
  addGoalBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#3D5A3E',
  },
});

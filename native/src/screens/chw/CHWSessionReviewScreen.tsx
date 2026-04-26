/**
 * CHWSessionReviewScreen — Post-session follow-up review for CHW users.
 *
 * Displayed after a session is marked complete and LLM extraction has run.
 * The CHW reviews each extracted follow-up item and:
 *   - Confirms, dismisses, or edits it inline
 *   - Toggles "Show on member's roadmap"
 *   - Changes owner (CHW / Member / Both)
 *
 * Confirmed items with owner == "member" | "both" that have showOnRoadmap==true
 * automatically appear on the MemberRoadmapScreen for the member to track.
 *
 * Navigation param: { sessionId: string; memberName: string }
 *
 * HIPAA: followup description values are never written to console.
 */

import React, {
  useCallback,
  useMemo,
  useState,
  useRef,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ArrowLeft,
  CheckCircle,
  XCircle,
  Edit2,
  ChevronDown,
  User,
  Users,
  Briefcase,
  Flag,
  CalendarDays,
  AlertCircle,
  CheckCheck,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography, fonts } from '../../theme/typography';
import {
  useSessionFollowups,
  useUpdateFollowup,
  type SessionFollowup,
  type FollowupOwner,
  type FollowupVertical,
  type FollowupPriority,
  type FollowupKind,
  type PatchFollowupPayload,
} from '../../hooks/useFollowupQueries';
import type { CHWSessionsStackParamList } from '../../navigation/CHWTabNavigator';

// ─── Navigation types ─────────────────────────────────────────────────────────

type ReviewRouteProp = RouteProp<CHWSessionsStackParamList, 'SessionReview'>;
type ReviewNavProp = NativeStackNavigationProp<CHWSessionsStackParamList, 'SessionReview'>;

// ─── Label maps ───────────────────────────────────────────────────────────────

const KIND_LABELS: Record<FollowupKind, string> = {
  action_item: 'Action Item',
  follow_up_task: 'Follow-Up Task',
  resource_referral: 'Resource',
  member_goal: 'Goal',
};

const KIND_COLORS: Record<FollowupKind, string> = {
  action_item: '#3B82F6',
  follow_up_task: '#F59E0B',
  resource_referral: '#06B6D4',
  member_goal: colors.primary,
};

const OWNER_LABELS: Record<FollowupOwner, string> = {
  chw: 'CHW',
  member: 'Member',
  both: 'Both',
};

const VERTICAL_LABELS: Record<FollowupVertical, string> = {
  housing: 'Housing',
  food: 'Food Security',
  mental_health: 'Mental Health',
  rehab: 'Rehab',
  healthcare: 'Healthcare',
};

const PRIORITY_LABELS: Record<FollowupPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const PRIORITY_COLORS: Record<FollowupPriority, string> = {
  low: colors.secondary,
  medium: colors.compassGold,
  high: colors.destructive,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDueDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Compute the default showOnRoadmap value for a followup.
 * True if owner involves the member, otherwise false.
 */
function defaultShowOnRoadmap(owner: FollowupOwner | null): boolean {
  return owner === 'member' || owner === 'both';
}

// ─── OwnerPicker ─────────────────────────────────────────────────────────────

interface OwnerPickerProps {
  current: FollowupOwner | null;
  onChange: (owner: FollowupOwner) => void;
}

function OwnerPicker({ current, onChange }: OwnerPickerProps): React.JSX.Element {
  const options: FollowupOwner[] = ['chw', 'member', 'both'];
  return (
    <View style={ownerStyles.row} accessibilityRole="radiogroup" accessibilityLabel="Owner">
      {options.map((opt) => {
        const selected = current === opt;
        return (
          <TouchableOpacity
            key={opt}
            style={[ownerStyles.chip, selected && ownerStyles.chipSelected]}
            onPress={() => onChange(opt)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={OWNER_LABELS[opt]}
          >
            {opt === 'chw' ? (
              <Briefcase size={12} color={selected ? colors.primaryForeground : colors.mutedForeground} />
            ) : opt === 'member' ? (
              <User size={12} color={selected ? colors.primaryForeground : colors.mutedForeground} />
            ) : (
              <Users size={12} color={selected ? colors.primaryForeground : colors.mutedForeground} />
            )}
            <Text style={[ownerStyles.chipText, selected && ownerStyles.chipTextSelected]}>
              {OWNER_LABELS[opt]}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const ownerStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: colors.mutedForeground,
  },
  chipTextSelected: {
    color: colors.primaryForeground,
  },
});

// ─── EditDescriptionModal ─────────────────────────────────────────────────────

interface EditDescriptionModalProps {
  visible: boolean;
  initialValue: string;
  onSave: (text: string) => void;
  onClose: () => void;
}

function EditDescriptionModal({
  visible,
  initialValue,
  onSave,
  onClose,
}: EditDescriptionModalProps): React.JSX.Element {
  const [draft, setDraft] = useState(initialValue);

  // Reset draft whenever modal opens with a new value
  const prevVisible = useRef(false);
  if (visible && !prevVisible.current) {
    prevVisible.current = true;
    // Sync draft to current value on open
    if (draft !== initialValue) setDraft(initialValue);
  } else if (!visible) {
    prevVisible.current = false;
  }

  const isValid = draft.trim().length > 0;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      accessible
      accessibilityViewIsModal
    >
      <KeyboardAvoidingView
        style={editModalStyles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={editModalStyles.sheet}>
          <View style={editModalStyles.header}>
            <Text style={editModalStyles.headerTitle}>Edit Item</Text>
            <TouchableOpacity
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Cancel edit"
              hitSlop={8}
            >
              <Text style={editModalStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>

          <TextInput
            style={editModalStyles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Describe the follow-up item…"
            placeholderTextColor={colors.mutedForeground}
            multiline
            autoFocus
            maxLength={500}
            accessibilityLabel="Follow-up description"
          />

          <TouchableOpacity
            style={[editModalStyles.saveBtn, !isValid && editModalStyles.saveBtnDisabled]}
            onPress={() => { if (isValid) { onSave(draft.trim()); } }}
            disabled={!isValid}
            accessibilityRole="button"
            accessibilityLabel="Save changes"
          >
            <Text style={[editModalStyles.saveBtnText, !isValid && editModalStyles.saveBtnTextDisabled]}>
              Save Changes
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const editModalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    gap: 16,
    ...Platform.select({
      ios: {
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.1,
        shadowRadius: 16,
      },
      android: { elevation: 16 },
    }),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontFamily: fonts.display,
    fontSize: 18,
    color: colors.foreground,
  },
  cancelText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.mutedForeground,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 14,
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.foreground,
    minHeight: 96,
    textAlignVertical: 'top',
  },
  saveBtn: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: Platform.OS === 'ios' ? 8 : 0,
  },
  saveBtnDisabled: { backgroundColor: colors.border },
  saveBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
    color: colors.primaryForeground,
  },
  saveBtnTextDisabled: { color: colors.mutedForeground },
});

// ─── FollowupCard ─────────────────────────────────────────────────────────────

interface FollowupCardProps {
  item: SessionFollowup;
  onConfirm: (id: string) => void;
  onDismiss: (id: string) => void;
  onEdit: (id: string) => void;
  onOwnerChange: (id: string, owner: FollowupOwner) => void;
  onRoadmapToggle: (id: string, show: boolean) => void;
}

function FollowupCard({
  item,
  onConfirm,
  onDismiss,
  onEdit,
  onOwnerChange,
  onRoadmapToggle,
}: FollowupCardProps): React.JSX.Element {
  const kindColor = KIND_COLORS[item.kind];
  const isConfirmed = item.status === 'confirmed';
  const isDismissed = item.status === 'dismissed';
  const isReviewed = isConfirmed || isDismissed;

  const cardBg = isConfirmed
    ? `${colors.primary}08`
    : isDismissed
    ? colors.muted
    : '#FFFFFF';

  const borderColor = isConfirmed
    ? `${colors.primary}40`
    : isDismissed
    ? colors.border
    : colors.border;

  return (
    <View
      style={[cardS.card, { backgroundColor: cardBg, borderColor }]}
      accessible
      accessibilityLabel={`Follow-up item: ${KIND_LABELS[item.kind]}. Status: ${item.status}`}
    >
      {/* Kind chip + status overlay */}
      <View style={cardS.topRow}>
        <View style={[cardS.kindChip, { backgroundColor: `${kindColor}18` }]}>
          <Text style={[cardS.kindChipText, { color: kindColor }]}>
            {KIND_LABELS[item.kind]}
          </Text>
        </View>

        {isConfirmed && (
          <View style={cardS.confirmedBadge}>
            <CheckCircle size={12} color={colors.primary} />
            <Text style={cardS.confirmedBadgeText}>Confirmed</Text>
          </View>
        )}
        {isDismissed && (
          <View style={cardS.dismissedBadge}>
            <XCircle size={12} color={colors.mutedForeground} />
            <Text style={cardS.dismissedBadgeText}>Dismissed</Text>
          </View>
        )}
      </View>

      {/* Description */}
      <Text
        style={[cardS.description, isDismissed && cardS.descriptionDimmed]}
        accessibilityLabel="Item description"
      >
        {item.description}
      </Text>

      {/* Meta row — vertical, priority, due date */}
      {(item.vertical || item.priority || item.dueDate) ? (
        <View style={cardS.metaRow}>
          {item.vertical ? (
            <View style={cardS.metaChip}>
              <Text style={cardS.metaChipText}>{VERTICAL_LABELS[item.vertical]}</Text>
            </View>
          ) : null}
          {item.priority ? (
            <View style={[cardS.metaChip, { borderColor: `${PRIORITY_COLORS[item.priority]}50` }]}>
              <Flag size={10} color={PRIORITY_COLORS[item.priority]} />
              <Text style={[cardS.metaChipText, { color: PRIORITY_COLORS[item.priority] }]}>
                {PRIORITY_LABELS[item.priority]}
              </Text>
            </View>
          ) : null}
          {item.dueDate ? (
            <View style={cardS.metaChip}>
              <CalendarDays size={10} color={colors.mutedForeground} />
              <Text style={cardS.metaChipText}>{formatDueDate(item.dueDate)}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Owner picker — hidden when dismissed */}
      {!isDismissed ? (
        <View style={cardS.ownerSection}>
          <Text style={cardS.fieldLabel}>Owner</Text>
          <OwnerPicker
            current={item.owner}
            onChange={(owner) => onOwnerChange(item.id, owner)}
          />
        </View>
      ) : null}

      {/* Show on roadmap toggle — only visible when owner involves member */}
      {!isDismissed && (item.owner === 'member' || item.owner === 'both') ? (
        <View style={cardS.roadmapRow}>
          <Text style={cardS.roadmapLabel}>Show on member's roadmap</Text>
          <Switch
            value={item.showOnRoadmap}
            onValueChange={(val) => onRoadmapToggle(item.id, val)}
            trackColor={{ false: colors.border, true: `${colors.primary}60` }}
            thumbColor={item.showOnRoadmap ? colors.primary : colors.muted}
            accessibilityRole="switch"
            accessibilityLabel="Show on member's roadmap"
            accessibilityState={{ checked: item.showOnRoadmap }}
          />
        </View>
      ) : null}

      {/* Action buttons */}
      {!isReviewed ? (
        <View style={cardS.actionRow}>
          <TouchableOpacity
            style={cardS.confirmBtn}
            onPress={() => onConfirm(item.id)}
            accessibilityRole="button"
            accessibilityLabel="Confirm this item"
          >
            <CheckCircle size={14} color={colors.primaryForeground} />
            <Text style={cardS.confirmBtnText}>Confirm</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={cardS.editBtn}
            onPress={() => onEdit(item.id)}
            accessibilityRole="button"
            accessibilityLabel="Edit this item"
          >
            <Edit2 size={14} color={colors.primary} />
            <Text style={cardS.editBtnText}>Edit</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={cardS.dismissBtn}
            onPress={() => onDismiss(item.id)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss this item"
          >
            <XCircle size={14} color={colors.mutedForeground} />
            <Text style={cardS.dismissBtnText}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={cardS.undoBtn}
          onPress={() => {
            // Revert to pending so the CHW can change their mind
            onConfirm(item.id); // flip back — parent handles toggling
          }}
          accessibilityRole="button"
          accessibilityLabel="Undo — return to pending"
        >
          <Text style={cardS.undoBtnText}>
            {isConfirmed ? 'Undo confirm' : 'Undo dismiss'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const cardS = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
    gap: 12,
    ...Platform.select({
      ios: {
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.06,
        shadowRadius: 16,
      },
      android: { elevation: 2 },
    }),
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  kindChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
  },
  kindChipText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 0.3,
  },
  confirmedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
  },
  confirmedBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    color: colors.primary,
  },
  dismissedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
  },
  dismissedBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    color: colors.mutedForeground,
  },
  description: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 22,
    color: colors.foreground,
  },
  descriptionDimmed: {
    color: colors.mutedForeground,
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
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  metaChipText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    color: colors.mutedForeground,
  },
  ownerSection: {
    gap: 8,
  },
  fieldLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: colors.mutedForeground,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  roadmapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  roadmapLabel: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.foreground,
    flex: 1,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  confirmBtn: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    paddingVertical: 10,
    borderRadius: 10,
  },
  confirmBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: colors.primaryForeground,
  },
  editBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.primary,
    paddingVertical: 10,
    borderRadius: 10,
  },
  editBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: colors.primary,
  },
  dismissBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.card,
  },
  dismissBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: colors.mutedForeground,
  },
  undoBtn: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  undoBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: colors.mutedForeground,
    textDecorationLine: 'underline',
  },
});

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * CHWSessionReviewScreen
 *
 * Route params: { sessionId, memberName }
 * Reads from followupQueryKeys.extraction(sessionId) — populated by
 * useExtractSessionFollowups before navigation.
 */
export function CHWSessionReviewScreen(): React.JSX.Element {
  const route = useRoute<ReviewRouteProp>();
  const navigation = useNavigation<ReviewNavProp>();
  const { sessionId, memberName } = route.params;

  const { data: extractionResult, isLoading, error } = useSessionFollowups(sessionId);
  const updateFollowup = useUpdateFollowup(sessionId);

  // Track which item's description is being edited
  const [editingId, setEditingId] = useState<string | null>(null);

  const followups = extractionResult?.followups ?? [];

  const pendingCount = useMemo(
    () => followups.filter((f) => f.status === 'pending').length,
    [followups],
  );

  const allReviewed = followups.length > 0 && pendingCount === 0;

  // ── Action handlers ─────────────────────────────────────────────────────────

  const handleConfirm = useCallback(
    (id: string) => {
      const item = followups.find((f) => f.id === id);
      if (!item) return;

      // If already confirmed, revert to pending (undo)
      const newStatus = item.status === 'confirmed' ? 'pending' : 'confirmed';
      const patch: PatchFollowupPayload = { status: newStatus };

      // Auto-set showOnRoadmap on first confirm if owner involves member
      if (newStatus === 'confirmed' && item.owner !== null) {
        patch.showOnRoadmap = defaultShowOnRoadmap(item.owner);
      }

      updateFollowup.mutate({ followupId: id, patch });
    },
    [followups, updateFollowup],
  );

  const handleDismiss = useCallback(
    (id: string) => {
      const item = followups.find((f) => f.id === id);
      if (!item) return;
      const newStatus = item.status === 'dismissed' ? 'pending' : 'dismissed';
      updateFollowup.mutate({
        followupId: id,
        patch: { status: newStatus, showOnRoadmap: false },
      });
    },
    [followups, updateFollowup],
  );

  const handleOwnerChange = useCallback(
    (id: string, owner: FollowupOwner) => {
      const showOnRoadmap = defaultShowOnRoadmap(owner);
      updateFollowup.mutate({ followupId: id, patch: { owner, showOnRoadmap } });
    },
    [updateFollowup],
  );

  const handleRoadmapToggle = useCallback(
    (id: string, show: boolean) => {
      updateFollowup.mutate({ followupId: id, patch: { showOnRoadmap: show } });
    },
    [updateFollowup],
  );

  const handleEditSave = useCallback(
    (description: string) => {
      if (!editingId) return;
      updateFollowup.mutate({ followupId: editingId, patch: { description } });
      setEditingId(null);
    },
    [editingId, updateFollowup],
  );

  // Bulk actions
  const handleConfirmAll = useCallback(() => {
    followups
      .filter((f) => f.status === 'pending')
      .forEach((f) => {
        const patch: PatchFollowupPayload = {
          status: 'confirmed',
          showOnRoadmap: f.owner !== null ? defaultShowOnRoadmap(f.owner) : false,
        };
        updateFollowup.mutate({ followupId: f.id, patch });
      });
  }, [followups, updateFollowup]);

  const handleDismissAll = useCallback(() => {
    followups
      .filter((f) => f.status === 'pending')
      .forEach((f) => {
        updateFollowup.mutate({
          followupId: f.id,
          patch: { status: 'dismissed', showOnRoadmap: false },
        });
      });
  }, [followups, updateFollowup]);

  // ── Edit modal data ─────────────────────────────────────────────────────────

  const editingItem = editingId
    ? followups.find((f) => f.id === editingId)
    : null;

  // ── Render ──────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <SafeAreaView style={s.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <View style={s.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={s.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={20} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={s.headerTitle} numberOfLines={1}>
            Review Items
          </Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={s.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={s.loadingText}>Extracting follow-ups…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error || !extractionResult) {
    return (
      <SafeAreaView style={s.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <View style={s.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={s.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={20} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Review Items</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={s.centered}>
          <AlertCircle size={40} color={colors.destructive} />
          <Text style={s.errorTitle}>Could not load follow-ups</Text>
          <Text style={s.errorSub}>
            Check your connection and try again.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (followups.length === 0) {
    return (
      <SafeAreaView style={s.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <View style={s.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={s.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={20} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={s.headerTitle} numberOfLines={1}>
            Review — {memberName}
          </Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={s.centered}>
          <CheckCheck size={40} color={colors.mutedForeground} />
          <Text style={s.emptyTitle}>No items extracted</Text>
          <Text style={s.emptySub}>
            No action items or goals were found in this session transcript.
          </Text>
          <TouchableOpacity
            style={s.doneBtn}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Return to sessions"
          >
            <Text style={s.doneBtnText}>Back to Sessions</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />

      {/* Edit description modal */}
      <EditDescriptionModal
        visible={editingId !== null}
        initialValue={editingItem?.description ?? ''}
        onSave={handleEditSave}
        onClose={() => setEditingId(null)}
      />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={s.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <ArrowLeft size={20} color={colors.foreground} />
        </TouchableOpacity>
        <View style={s.headerCenter}>
          <Text style={s.headerTitle} numberOfLines={1}>
            Review Session Items
          </Text>
          <Text style={s.headerSub} numberOfLines={1}>
            {memberName}
          </Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      {/* Summary strip */}
      <View style={s.summaryStrip}>
        <Text style={s.summaryText}>
          {followups.length} item{followups.length !== 1 ? 's' : ''}
          {pendingCount > 0 ? ` · ${pendingCount} pending` : ' · all reviewed'}
        </Text>
      </View>

      {/* Bulk actions — only shown when pending items remain */}
      {pendingCount > 0 ? (
        <View style={s.bulkRow}>
          <TouchableOpacity
            style={s.bulkConfirmBtn}
            onPress={handleConfirmAll}
            accessibilityRole="button"
            accessibilityLabel="Confirm all pending items"
          >
            <CheckCheck size={14} color={colors.primaryForeground} />
            <Text style={s.bulkConfirmText}>Confirm All</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.bulkDismissBtn}
            onPress={handleDismissAll}
            accessibilityRole="button"
            accessibilityLabel="Dismiss all pending items"
          >
            <XCircle size={14} color={colors.mutedForeground} />
            <Text style={s.bulkDismissText}>Dismiss All</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Item list */}
      <FlatList
        data={followups}
        keyExtractor={(item) => item.id}
        contentContainerStyle={s.listContent}
        showsVerticalScrollIndicator={false}
        accessibilityRole="list"
        accessibilityLabel="Follow-up items"
        renderItem={({ item }) => (
          <FollowupCard
            item={item}
            onConfirm={handleConfirm}
            onDismiss={handleDismiss}
            onEdit={(id) => setEditingId(id)}
            onOwnerChange={handleOwnerChange}
            onRoadmapToggle={handleRoadmapToggle}
          />
        )}
        ListFooterComponent={
          allReviewed ? (
            <View style={s.allReviewedCard}>
              <CheckCheck size={28} color={colors.primary} />
              <Text style={s.allReviewedTitle}>All items reviewed</Text>
              <Text style={s.allReviewedSub}>
                Confirmed items with member ownership will appear on{' '}
                {memberName}&apos;s roadmap.
              </Text>
              <TouchableOpacity
                style={s.doneBtn}
                onPress={() => navigation.goBack()}
                accessibilityRole="button"
                accessibilityLabel={`Mark session complete and notify ${memberName}`}
              >
                <Text style={s.doneBtnText}>
                  Done — Notify {memberName}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
    gap: 8,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontFamily: fonts.display,
    fontSize: 17,
    color: colors.foreground,
  },
  headerSub: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    marginTop: 1,
  },
  summaryStrip: {
    backgroundColor: colors.card,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  summaryText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: colors.mutedForeground,
    letterSpacing: 0.5,
  },
  bulkRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bulkConfirmBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    paddingVertical: 10,
    borderRadius: 10,
  },
  bulkConfirmText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: colors.primaryForeground,
  },
  bulkDismissBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
  },
  bulkDismissText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: colors.mutedForeground,
  },
  listContent: {
    padding: 16,
    paddingBottom: 32,
  },
  allReviewedCard: {
    alignItems: 'center',
    backgroundColor: `${colors.primary}08`,
    borderWidth: 1,
    borderColor: `${colors.primary}30`,
    borderRadius: 16,
    padding: 24,
    gap: 10,
    marginBottom: 16,
  },
  allReviewedTitle: {
    fontFamily: fonts.display,
    fontSize: 18,
    color: colors.foreground,
  },
  allReviewedSub: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 20,
  },
  doneBtn: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginTop: 4,
  },
  doneBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.primaryForeground,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
  },
  loadingText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.mutedForeground,
    marginTop: 8,
  },
  errorTitle: {
    fontFamily: fonts.display,
    fontSize: 18,
    color: colors.foreground,
  },
  errorSub: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.mutedForeground,
    textAlign: 'center',
  },
  emptyTitle: {
    fontFamily: fonts.display,
    fontSize: 18,
    color: colors.foreground,
  },
  emptySub: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 22,
  },
});

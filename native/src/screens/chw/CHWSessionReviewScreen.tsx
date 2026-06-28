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
 * automatically appear on the member's My Journey screen for the member to track.
 *
 * Navigation param: { sessionId: string; memberName: string; memberId?: string }
 *
 * HIPAA: followup description values are never written to console.
 *
 * Layout: single-column with Card-wrapped sections.
 * Rationale: this is a sequential review flow — each item is an interactive
 * action card (confirm / dismiss / edit). A 3-column layout would fragment the
 * reading order and bury action buttons in narrow columns. Single-column with a
 * maxWidth cap (960px on web) matches the admin aesthetic while keeping the
 * review flow linear and scannable.
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
  User,
  Users,
  Briefcase,
  Flag,
  CalendarDays,
  AlertCircle,
  CheckCheck,
  ClipboardCheck,
  ListTodo,
  Clock,
} from 'lucide-react-native';

import { colors as tokens, spacing, radius, shadows } from '../../theme/tokens';
import { fonts } from '../../theme/typography';
import {
  Card,
  SectionHeader,
  StatTile,
  Pill,
} from '../../components/ui';
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

/**
 * Maps follow-up kind to a Pill variant so item-type chips use the shared
 * design-system token pairs instead of arbitrary hex values.
 *
 * Note: `member_goal` uses `blue` (informational) not `purple`; purple is
 * reserved exclusively for AI-generated content tags.
 */
const KIND_PILL_VARIANT: Record<FollowupKind, 'blue' | 'amber' | 'emerald'> = {
  action_item:       'blue',
  follow_up_task:    'amber',
  resource_referral: 'emerald',
  member_goal:       'blue',
};

const OWNER_LABELS: Record<FollowupOwner, string> = {
  chw:    'CHW',
  member: 'Member',
  both:   'Both',
};

const VERTICAL_LABELS: Record<FollowupVertical, string> = {
  housing:        'Housing',
  food:           'Food Security',
  mental_health:  'Mental Health',
  transportation: 'Transportation',
  healthcare:     'Healthcare',
  employment:     'Employment',
};

const PRIORITY_LABELS: Record<FollowupPriority, string> = {
  low:    'Low',
  medium: 'Medium',
  high:   'High',
};

/**
 * Maps priority level to a Pill variant, replacing the previous inline
 * hex-literal approach with canonical design-system semantic pairs.
 */
const PRIORITY_PILL_VARIANT: Record<FollowupPriority, 'gray' | 'amber' | 'red'> = {
  low:    'gray',
  medium: 'amber',
  high:   'red',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formats an ISO date string as a short human-readable date (e.g. "Jun 12, 2026").
 */
function formatDueDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day:   'numeric',
    year:  'numeric',
  });
}

/**
 * Returns true when the follow-up owner indicates the member should see it
 * on their roadmap. Defaults showOnRoadmap to true for member-facing items.
 */
function defaultShowOnRoadmap(owner: FollowupOwner | null): boolean {
  return owner === 'member' || owner === 'both';
}

// ─── OwnerPicker ─────────────────────────────────────────────────────────────

interface OwnerPickerProps {
  current: FollowupOwner | null;
  onChange: (owner: FollowupOwner) => void;
}

/**
 * Three-chip radio group for selecting who owns the follow-up action:
 * CHW, Member, or Both. Selected chip fills with the primary brand green.
 */
function OwnerPicker({ current, onChange }: OwnerPickerProps): React.JSX.Element {
  const options: FollowupOwner[] = ['chw', 'member', 'both'];

  return (
    <View style={ownerStyles.row} accessibilityRole="radiogroup" accessibilityLabel="Owner">
      {options.map((opt) => {
        const selected = current === opt;

        const icon =
          opt === 'chw' ? (
            <Briefcase size={12} color={selected ? '#FFFFFF' : tokens.textSecondary} />
          ) : opt === 'member' ? (
            <User size={12} color={selected ? '#FFFFFF' : tokens.textSecondary} />
          ) : (
            <Users size={12} color={selected ? '#FFFFFF' : tokens.textSecondary} />
          );

        return (
          <TouchableOpacity
            key={opt}
            style={[ownerStyles.chip, selected && ownerStyles.chipSelected]}
            onPress={() => onChange(opt)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={OWNER_LABELS[opt]}
          >
            {icon}
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
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  chip: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical:   6,
    borderRadius:   radius.pill,
    borderWidth:    1,
    borderColor:    tokens.cardBorder,
    backgroundColor: tokens.cardBg,
  },
  chipSelected: {
    backgroundColor: tokens.primary,
    borderColor:     tokens.primary,
  },
  chipText: {
    fontFamily: fonts.bodySemibold,
    fontSize:   12,
    color:      tokens.textSecondary,
  },
  chipTextSelected: {
    color: '#FFFFFF',
  },
});

// ─── EditDescriptionModal ─────────────────────────────────────────────────────

interface EditDescriptionModalProps {
  visible:      boolean;
  initialValue: string;
  onSave:       (text: string) => void;
  onClose:      () => void;
}

/**
 * Bottom-sheet modal for editing a follow-up item's description inline.
 * Resets the draft text each time the modal opens to prevent stale state.
 * HIPAA: draft text is never logged.
 */
function EditDescriptionModal({
  visible,
  initialValue,
  onSave,
  onClose,
}: EditDescriptionModalProps): React.JSX.Element {
  const [draft, setDraft] = useState(initialValue);

  // Sync draft to the current initialValue whenever the modal re-opens.
  const prevVisible = useRef(false);
  if (visible && !prevVisible.current) {
    prevVisible.current = true;
    if (draft !== initialValue) {
      setDraft(initialValue);
    }
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
            placeholderTextColor={tokens.textMuted}
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
    backgroundColor: tokens.cardBg,
    borderTopLeftRadius:  radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.xl,
    gap: spacing.lg,
    ...Platform.select({
      ios: {
        shadowColor:   '#000',
        shadowOffset:  { width: 0, height: -4 },
        shadowOpacity: 0.08,
        shadowRadius:  16,
      },
      android: { elevation: 16 },
    }),
  },
  header: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontFamily: fonts.display,
    fontSize:   18,
    color:      tokens.textPrimary,
  },
  cancelText: {
    fontFamily: fonts.bodySemibold,
    fontSize:   14,
    color:      tokens.textSecondary,
  },
  input: {
    borderWidth:       1,
    borderColor:       tokens.cardBorder,
    borderRadius:      radius.lg,
    padding:           spacing.md,
    fontFamily:        fonts.body,
    fontSize:          15,
    color:             tokens.textPrimary,
    minHeight:         96,
    textAlignVertical: 'top',
  },
  saveBtn: {
    backgroundColor: tokens.primary,
    borderRadius:    radius.lg,
    paddingVertical: 14,
    alignItems:      'center',
    marginBottom:    Platform.OS === 'ios' ? spacing.sm : 0,
  },
  saveBtnDisabled: {
    backgroundColor: tokens.cardBorder,
  },
  saveBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize:   15,
    color:      '#FFFFFF',
  },
  saveBtnTextDisabled: {
    color: tokens.textSecondary,
  },
});

// ─── FollowupItemCard ─────────────────────────────────────────────────────────

interface FollowupItemCardProps {
  item:           SessionFollowup;
  onConfirm:      (id: string) => void;
  onDismiss:      (id: string) => void;
  onEdit:         (id: string) => void;
  onOwnerChange:  (id: string, owner: FollowupOwner) => void;
  onRoadmapToggle:(id: string, show: boolean) => void;
}

/**
 * Single-item review card. Renders item type, description, metadata (vertical /
 * priority / due date), owner picker, roadmap toggle, and confirm/edit/dismiss
 * action buttons. Uses Card primitive for surface + token-aligned colors.
 *
 * All fields and payload shape are unchanged from the original screen — this
 * is a visual/token redesign only.
 */
function FollowupItemCard({
  item,
  onConfirm,
  onDismiss,
  onEdit,
  onOwnerChange,
  onRoadmapToggle,
}: FollowupItemCardProps): React.JSX.Element {
  const isConfirmed = item.status === 'confirmed';
  const isDismissed = item.status === 'dismissed';
  const isReviewed  = isConfirmed || isDismissed;

  // Card background and border tint based on review state.
  const cardOverrideStyle = isConfirmed
    ? { backgroundColor: `${tokens.primary}08`, borderColor: `${tokens.primary}40` }
    : isDismissed
    ? { backgroundColor: tokens.pageBg, borderColor: tokens.cardBorder }
    : {};

  return (
    <Card
      style={[itemCardStyles.card, cardOverrideStyle]}
      accessibilityLabel={`Follow-up item: ${KIND_LABELS[item.kind]}. Status: ${item.status}`}
    >
      {/* ── Top row: kind pill + status badge ───────────────────────────── */}
      <View style={itemCardStyles.topRow}>
        <Pill variant={KIND_PILL_VARIANT[item.kind]} size="sm">
          {KIND_LABELS[item.kind]}
        </Pill>

        {isConfirmed && (
          <View style={itemCardStyles.statusBadge}>
            <CheckCircle size={12} color={tokens.primary} />
            <Text style={[itemCardStyles.statusBadgeText, { color: tokens.primary }]}>
              Confirmed
            </Text>
          </View>
        )}
        {isDismissed && (
          <View style={itemCardStyles.statusBadge}>
            <XCircle size={12} color={tokens.textSecondary} />
            <Text style={[itemCardStyles.statusBadgeText, { color: tokens.textSecondary }]}>
              Dismissed
            </Text>
          </View>
        )}
      </View>

      {/* ── Description ─────────────────────────────────────────────────── */}
      <Text
        style={[
          itemCardStyles.description,
          isDismissed && itemCardStyles.descriptionDimmed,
        ]}
        accessibilityLabel="Item description"
      >
        {item.description}
      </Text>

      {/* ── Metadata chips: vertical / priority / due date ──────────────── */}
      {(item.vertical !== null || item.priority !== null || item.dueDate !== null) && (
        <View style={itemCardStyles.metaRow}>
          {item.vertical !== null && (
            <View style={itemCardStyles.metaChip}>
              <Text style={itemCardStyles.metaChipText}>
                {VERTICAL_LABELS[item.vertical]}
              </Text>
            </View>
          )}
          {item.priority !== null && (
            <Pill variant={PRIORITY_PILL_VARIANT[item.priority]} size="sm">
              <View style={itemCardStyles.priorityInner}>
                <Flag size={9} color="inherit" />
                <Text> {PRIORITY_LABELS[item.priority]}</Text>
              </View>
            </Pill>
          )}
          {item.dueDate !== null && (
            <View style={itemCardStyles.metaChip}>
              <CalendarDays size={10} color={tokens.textSecondary} />
              <Text style={itemCardStyles.metaChipText}>
                {formatDueDate(item.dueDate)}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* ── Owner picker (hidden when dismissed) ────────────────────────── */}
      {!isDismissed && (
        <View style={itemCardStyles.ownerSection}>
          <Text style={itemCardStyles.fieldLabel}>Owner</Text>
          <OwnerPicker
            current={item.owner}
            onChange={(owner) => onOwnerChange(item.id, owner)}
          />
        </View>
      )}

      {/* ── Roadmap toggle (member-facing items only) ────────────────────── */}
      {!isDismissed && (item.owner === 'member' || item.owner === 'both') && (
        <View style={itemCardStyles.roadmapRow}>
          <Text style={itemCardStyles.roadmapLabel}>Show on member's roadmap</Text>
          <Switch
            value={item.showOnRoadmap}
            onValueChange={(val) => onRoadmapToggle(item.id, val)}
            trackColor={{ false: tokens.cardBorder, true: `${tokens.primary}60` }}
            thumbColor={item.showOnRoadmap ? tokens.primary : '#e5e7eb'}
            accessibilityRole="switch"
            accessibilityLabel="Show on member's roadmap"
            accessibilityState={{ checked: item.showOnRoadmap }}
          />
        </View>
      )}

      {/* ── Action buttons / undo ────────────────────────────────────────── */}
      {!isReviewed ? (
        <View style={itemCardStyles.actionRow}>
          <TouchableOpacity
            style={itemCardStyles.confirmBtn}
            onPress={() => onConfirm(item.id)}
            accessibilityRole="button"
            accessibilityLabel="Confirm this item"
          >
            <CheckCircle size={14} color="#FFFFFF" />
            <Text style={itemCardStyles.confirmBtnText}>Confirm</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={itemCardStyles.editBtn}
            onPress={() => onEdit(item.id)}
            accessibilityRole="button"
            accessibilityLabel="Edit this item"
          >
            <Edit2 size={14} color={tokens.primary} />
            <Text style={itemCardStyles.editBtnText}>Edit</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={itemCardStyles.dismissBtn}
            onPress={() => onDismiss(item.id)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss this item"
          >
            <XCircle size={14} color={tokens.textSecondary} />
            <Text style={itemCardStyles.dismissBtnText}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={itemCardStyles.undoBtn}
          onPress={() => {
            // Toggling via the same handler: confirmed → pending, dismissed → pending.
            if (isConfirmed) {
              onConfirm(item.id);
            } else {
              onDismiss(item.id);
            }
          }}
          accessibilityRole="button"
          accessibilityLabel="Undo — return to pending"
        >
          <Text style={itemCardStyles.undoBtnText}>
            {isConfirmed ? 'Undo confirm' : 'Undo dismiss'}
          </Text>
        </TouchableOpacity>
      )}
    </Card>
  );
}

const itemCardStyles = StyleSheet.create({
  card: {
    marginBottom: spacing.md,
    padding:      spacing.xl,
    gap:          spacing.md,
  },
  topRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.xs,
    marginLeft:    'auto' as unknown as number,
  },
  statusBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize:   11,
  },
  description: {
    fontFamily: fonts.body,
    fontSize:   14,
    lineHeight: 22,
    color:      tokens.textPrimary,
  },
  descriptionDimmed: {
    color: tokens.textMuted,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           spacing.sm,
    alignItems:    'center',
  },
  metaChip: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical:   3,
    borderRadius:      radius.sm,
    borderWidth:       1,
    borderColor:       tokens.cardBorder,
    backgroundColor:   tokens.pageBg,
  },
  metaChipText: {
    fontFamily: fonts.bodySemibold,
    fontSize:   11,
    color:      tokens.textSecondary,
  },
  priorityInner: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           3,
  },
  ownerSection: {
    gap: spacing.sm,
  },
  fieldLabel: {
    fontFamily:    fonts.bodySemibold,
    fontSize:      11,
    color:         tokens.textMuted,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  roadmapRow: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    paddingTop:     spacing.sm,
    borderTopWidth: 1,
    borderTopColor: tokens.cardBorder,
  },
  roadmapLabel: {
    fontFamily: fonts.body,
    fontSize:   13,
    color:      tokens.textPrimary,
    flex:       1,
  },
  actionRow: {
    flexDirection:  'row',
    gap:            spacing.sm,
    paddingTop:     spacing.sm,
    borderTopWidth: 1,
    borderTopColor: tokens.cardBorder,
  },
  confirmBtn: {
    flex:           2,
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            6,
    backgroundColor: tokens.primary,
    paddingVertical: 10,
    borderRadius:    radius.md,
  },
  confirmBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize:   13,
    color:      '#FFFFFF',
  },
  editBtn: {
    flex:           1,
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            6,
    borderWidth:    1,
    borderColor:    tokens.primary,
    paddingVertical: 10,
    borderRadius:    radius.md,
  },
  editBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize:   13,
    color:      tokens.primary,
  },
  dismissBtn: {
    flex:           1,
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            6,
    borderWidth:    1,
    borderColor:    tokens.cardBorder,
    paddingVertical: 10,
    borderRadius:    radius.md,
    backgroundColor: tokens.pageBg,
  },
  dismissBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize:   13,
    color:      tokens.textSecondary,
  },
  undoBtn: {
    alignItems:      'center',
    paddingVertical: spacing.sm,
  },
  undoBtnText: {
    fontFamily:     fonts.bodySemibold,
    fontSize:       12,
    color:          tokens.textSecondary,
    textDecorationLine: 'underline',
  },
});

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * CHWSessionReviewScreen
 *
 * Route params: { sessionId, memberName, memberId? }
 * Reads from followupQueryKeys.extraction(sessionId) — populated by
 * useExtractSessionFollowups before navigation.
 *
 * The member name in the header subtitle is tappable when the route carries
 * a memberId, navigating to CHWMemberProfileScreen.
 */
export function CHWSessionReviewScreen(): React.JSX.Element {
  const route      = useRoute<ReviewRouteProp>();
  const navigation = useNavigation<ReviewNavProp>();
  const { sessionId, memberName } = route.params;

  // Optional — present when navigation originated from a session card that
  // carries a member_id. Makes the subtitle name tappable (HIPAA-gated).
  const memberId = (route.params as { memberId?: string }).memberId;

  const { data: extractionResult, isLoading, error } = useSessionFollowups(sessionId);
  const updateFollowup = useUpdateFollowup(sessionId);

  // Track which item's description is being edited in the bottom-sheet modal.
  const [editingId, setEditingId] = useState<string | null>(null);

  const followups = extractionResult?.followups ?? [];

  const confirmedCount = useMemo(
    () => followups.filter((f) => f.status === 'confirmed').length,
    [followups],
  );

  const pendingCount = useMemo(
    () => followups.filter((f) => f.status === 'pending').length,
    [followups],
  );

  const allReviewed = followups.length > 0 && pendingCount === 0;

  // ── Action handlers ─────────────────────────────────────────────────────────

  const handleConfirm = useCallback(
    (id: string) => {
      const item = followups.find((f) => f.id === id);
      if (!item) { return; }

      // Toggle: confirmed → pending (undo), or pending/dismissed → confirmed.
      const newStatus = item.status === 'confirmed' ? 'pending' : 'confirmed';
      const patch: PatchFollowupPayload = { status: newStatus };

      // Auto-set showOnRoadmap on first confirm when owner involves the member.
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
      if (!item) { return; }

      // Toggle: dismissed → pending (undo), or pending → dismissed.
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
      if (!editingId) { return; }
      updateFollowup.mutate({ followupId: editingId, patch: { description } });
      setEditingId(null);
    },
    [editingId, updateFollowup],
  );

  // Bulk: confirm all pending items, auto-setting roadmap visibility.
  const handleConfirmAll = useCallback(() => {
    followups
      .filter((f) => f.status === 'pending')
      .forEach((f) => {
        const patch: PatchFollowupPayload = {
          status:       'confirmed',
          showOnRoadmap: f.owner !== null ? defaultShowOnRoadmap(f.owner) : false,
        };
        updateFollowup.mutate({ followupId: f.id, patch });
      });
  }, [followups, updateFollowup]);

  // Bulk: dismiss all pending items, stripping roadmap visibility.
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

  // ── Edit modal ──────────────────────────────────────────────────────────────

  const editingItem = editingId ? followups.find((f) => f.id === editingId) : null;

  // ── Loading state ───────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <SafeAreaView style={screenStyles.safeArea} edges={['top']}>
        <View style={screenStyles.pageWrap}>
          <View style={screenStyles.navBar}>
            <TouchableOpacity
              onPress={() => navigation.goBack()}
              style={screenStyles.backBtn}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <ArrowLeft size={20} color={tokens.textPrimary} />
            </TouchableOpacity>
            <Text style={screenStyles.navTitle}>Complete Session</Text>
            <View style={{ width: 40 }} />
          </View>
          <View style={screenStyles.centered}>
            <ActivityIndicator size="large" color={tokens.primary} />
            <Text style={screenStyles.stateBodyText}>Extracting follow-ups…</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ── Error state ─────────────────────────────────────────────────────────────

  if (error !== null && error !== undefined || !extractionResult) {
    return (
      <SafeAreaView style={screenStyles.safeArea} edges={['top']}>
        <View style={screenStyles.pageWrap}>
          <View style={screenStyles.navBar}>
            <TouchableOpacity
              onPress={() => navigation.goBack()}
              style={screenStyles.backBtn}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <ArrowLeft size={20} color={tokens.textPrimary} />
            </TouchableOpacity>
            <Text style={screenStyles.navTitle}>Complete Session</Text>
            <View style={{ width: 40 }} />
          </View>
          <View style={screenStyles.centered}>
            <AlertCircle size={40} color={tokens.red700} />
            <Text style={screenStyles.stateHeading}>Could not load follow-ups</Text>
            <Text style={screenStyles.stateBodyText}>
              Check your connection and try again.
            </Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ── Empty state (no items extracted from transcript) ────────────────────────

  if (followups.length === 0) {
    return (
      <SafeAreaView style={screenStyles.safeArea} edges={['top']}>
        <View style={screenStyles.pageWrap}>
          <View style={screenStyles.navBar}>
            <TouchableOpacity
              onPress={() => navigation.goBack()}
              style={screenStyles.backBtn}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <ArrowLeft size={20} color={tokens.textPrimary} />
            </TouchableOpacity>
            <Text style={screenStyles.navTitle} numberOfLines={1}>
              Complete Session — {memberName}
            </Text>
            <View style={{ width: 40 }} />
          </View>
          <View style={screenStyles.centered}>
            <CheckCheck size={40} color={tokens.textSecondary} />
            <Text style={screenStyles.stateHeading}>No items extracted</Text>
            <Text style={screenStyles.stateBodyText}>
              No action items or goals were found in this session's transcript.
            </Text>
            <TouchableOpacity
              style={screenStyles.primaryBtn}
              onPress={() => navigation.goBack()}
              accessibilityRole="button"
              accessibilityLabel="Return to sessions"
            >
              <Text style={screenStyles.primaryBtnText}>Back to Sessions</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ── Main render ─────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={screenStyles.safeArea} edges={['top']}>
      {/* Edit description bottom-sheet */}
      <EditDescriptionModal
        visible={editingId !== null}
        initialValue={editingItem?.description ?? ''}
        onSave={handleEditSave}
        onClose={() => setEditingId(null)}
      />

      <View style={screenStyles.pageWrap}>
        {/* ── Navigation bar ─────────────────────────────────────────────── */}
        <View style={screenStyles.navBar}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={screenStyles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={20} color={tokens.textPrimary} />
          </TouchableOpacity>

          <View style={screenStyles.navCenter}>
            <Text style={screenStyles.navTitle} numberOfLines={1}>
              Complete Session
            </Text>
            {/* Member name — tappable link when memberId is present in route params */}
            {memberId !== undefined ? (
              <TouchableOpacity
                onPress={() => navigation.navigate('MemberProfile', { memberId })}
                accessibilityRole="link"
                accessibilityLabel={`View profile for ${memberName}`}
                hitSlop={4}
              >
                <Text style={[screenStyles.navSubtitle, screenStyles.navSubtitleLink]} numberOfLines={1}>
                  {memberName}
                </Text>
              </TouchableOpacity>
            ) : (
              <Text style={screenStyles.navSubtitle} numberOfLines={1}>
                {memberName}
              </Text>
            )}
          </View>

          <View style={{ width: 40 }} />
        </View>

        {/* ── Scrollable content ──────────────────────────────────────────── */}
        <FlatList
          data={followups}
          keyExtractor={(item) => item.id}
          contentContainerStyle={screenStyles.listContent}
          showsVerticalScrollIndicator={false}
          accessibilityRole="list"
          accessibilityLabel="Follow-up items"
          ListHeaderComponent={(
            <>
              {/* ── Summary StatTile row ──────────────────────────────────── */}
              <View style={screenStyles.statRow}>
                <StatTile
                  icon={<ListTodo size={18} color={tokens.emerald700} />}
                  iconBg={tokens.emerald100}
                  label="Total Items"
                  value={followups.length}
                  style={screenStyles.statTile}
                  accessibilityLabel={`${followups.length} total items`}
                />
                <StatTile
                  icon={<ClipboardCheck size={18} color={tokens.emerald700} />}
                  iconBg={tokens.emerald100}
                  label="Confirmed"
                  value={confirmedCount}
                  delta={confirmedCount > 0 ? `${confirmedCount} done` : undefined}
                  deltaColor={tokens.emerald700}
                  deltaBg={tokens.emerald100}
                  style={screenStyles.statTile}
                  accessibilityLabel={`${confirmedCount} confirmed`}
                />
                <StatTile
                  icon={<Clock size={18} color={pendingCount > 0 ? tokens.amber700 : tokens.textMuted} />}
                  iconBg={pendingCount > 0 ? tokens.amber100 : tokens.gray100}
                  label="Pending"
                  value={pendingCount}
                  delta={pendingCount > 0 ? 'Needs review' : undefined}
                  deltaColor={tokens.amber700}
                  deltaBg={tokens.amber100}
                  style={screenStyles.statTile}
                  accessibilityLabel={`${pendingCount} pending`}
                />
              </View>

              {/* ── Bulk actions (only while pending items remain) ─────────── */}
              {pendingCount > 0 && (
                <Card style={screenStyles.bulkCard}>
                  <SectionHeader
                    title="Quick Actions"
                    subtitle="Apply to all pending items at once"
                    marginBottom={spacing.md}
                  />
                  <View style={screenStyles.bulkRow}>
                    <TouchableOpacity
                      style={screenStyles.bulkConfirmBtn}
                      onPress={handleConfirmAll}
                      accessibilityRole="button"
                      accessibilityLabel="Confirm all pending items"
                    >
                      <CheckCheck size={14} color="#FFFFFF" />
                      <Text style={screenStyles.bulkConfirmText}>Confirm All</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={screenStyles.bulkDismissBtn}
                      onPress={handleDismissAll}
                      accessibilityRole="button"
                      accessibilityLabel="Dismiss all pending items"
                    >
                      <XCircle size={14} color={tokens.textSecondary} />
                      <Text style={screenStyles.bulkDismissText}>Dismiss All</Text>
                    </TouchableOpacity>
                  </View>
                </Card>
              )}

              {/* ── Items section header ──────────────────────────────────── */}
              <SectionHeader
                title="Extracted Follow-ups"
                subtitle={
                  pendingCount > 0
                    ? `${pendingCount} item${pendingCount !== 1 ? 's' : ''} awaiting review`
                    : 'All items reviewed'
                }
                marginBottom={spacing.md}
              />
            </>
          )}
          renderItem={({ item }) => (
            <FollowupItemCard
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
              <Card style={screenStyles.completionCard}>
                <View style={screenStyles.completionIconWrap}>
                  <CheckCheck size={28} color={tokens.primary} />
                </View>
                <Text style={screenStyles.completionTitle}>All items reviewed</Text>
                <Text style={screenStyles.completionBody}>
                  Confirmed items with member ownership will appear on{' '}
                  {memberName}&apos;s roadmap.
                </Text>
                <TouchableOpacity
                  style={screenStyles.primaryBtn}
                  onPress={() => navigation.goBack()}
                  accessibilityRole="button"
                  accessibilityLabel={`Mark complete and notify ${memberName}`}
                >
                  <Text style={screenStyles.primaryBtnText}>
                    Done — Notify {memberName}
                  </Text>
                </TouchableOpacity>
              </Card>
            ) : null
          }
        />
      </View>
    </SafeAreaView>
  );
}

// ─── Screen-level styles ──────────────────────────────────────────────────────

const screenStyles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: tokens.pageBg,
  },

  // Full-width on web — review cards fill the available content area.
  // Raised from 960 → no cap so content breathes on 1280px+ viewports.
  pageWrap: {
    width:     '100%',
    maxWidth:  1280,
    alignSelf: 'center',
    flex:      1,
  },

  // ── Navigation bar ────────────────────────────────────────────────────────
  navBar: {
    flexDirection:   'row',
    alignItems:      'center',
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
    backgroundColor:   tokens.cardBg,
    gap: spacing.sm,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    radius.lg,
    backgroundColor: tokens.pageBg,
    borderWidth:     1,
    borderColor:     tokens.cardBorder,
    alignItems:      'center',
    justifyContent:  'center',
  },
  navCenter: {
    flex:       1,
    alignItems: 'center',
  },
  navTitle: {
    fontFamily: fonts.display,
    fontSize:   17,
    color:      tokens.textPrimary,
  },
  navSubtitle: {
    fontFamily: fonts.body,
    fontSize:   12,
    color:      tokens.textSecondary,
    marginTop:  2,
  },
  navSubtitleLink: {
    color:              tokens.primary,
    textDecorationLine: 'underline',
  },

  // ── List layout ────────────────────────────────────────────────────────────
  listContent: {
    padding:       spacing.lg,
    paddingBottom: spacing.xxxl,
  },

  // ── StatTile summary row ──────────────────────────────────────────────────
  statRow: {
    flexDirection: 'row',
    gap:           spacing.md,
    marginBottom:  spacing.lg,
  },
  statTile: {
    flex:     1,
    // Compact tile variant: no delta layout shifts on small tiles.
    minWidth: 88,
  },

  // ── Bulk actions card ──────────────────────────────────────────────────────
  bulkCard: {
    padding:      spacing.xl,
    marginBottom: spacing.lg,
  },
  bulkRow: {
    flexDirection: 'row',
    gap:           spacing.md,
  },
  bulkConfirmBtn: {
    flex:           1,
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            6,
    backgroundColor: tokens.primary,
    paddingVertical: 10,
    borderRadius:    radius.md,
  },
  bulkConfirmText: {
    fontFamily: fonts.bodySemibold,
    fontSize:   13,
    color:      '#FFFFFF',
  },
  bulkDismissBtn: {
    flex:           1,
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            6,
    borderWidth:    1,
    borderColor:    tokens.cardBorder,
    paddingVertical: 10,
    borderRadius:    radius.md,
    backgroundColor: tokens.pageBg,
  },
  bulkDismissText: {
    fontFamily: fonts.bodySemibold,
    fontSize:   13,
    color:      tokens.textSecondary,
  },

  // ── Completion state card ─────────────────────────────────────────────────
  completionCard: {
    padding:      spacing.xxl,
    alignItems:   'center',
    gap:          spacing.md,
    marginBottom: spacing.lg,
    backgroundColor: `${tokens.primary}06`,
    borderColor:     `${tokens.primary}30`,
  },
  completionIconWrap: {
    width:           56,
    height:          56,
    borderRadius:    radius.pill,
    backgroundColor: tokens.emerald100,
    alignItems:      'center',
    justifyContent:  'center',
  },
  completionTitle: {
    fontFamily: fonts.display,
    fontSize:   20,
    color:      tokens.textPrimary,
  },
  completionBody: {
    fontFamily: fonts.body,
    fontSize:   13,
    color:      tokens.textSecondary,
    textAlign:  'center',
    lineHeight: 20,
  },

  // ── Shared button ─────────────────────────────────────────────────────────
  primaryBtn: {
    backgroundColor: tokens.primary,
    borderRadius:    radius.lg,
    paddingVertical:   12,
    paddingHorizontal: spacing.xxl,
    alignItems:      'center',
    marginTop:       spacing.xs,
  },
  primaryBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize:   14,
    color:      '#FFFFFF',
  },

  // ── State screens (loading / error / empty) ───────────────────────────────
  centered: {
    flex:           1,
    alignItems:     'center',
    justifyContent: 'center',
    padding:        spacing.xxxl,
    gap:            spacing.md,
  },
  stateHeading: {
    fontFamily: fonts.display,
    fontSize:   18,
    color:      tokens.textPrimary,
  },
  stateBodyText: {
    fontFamily: fonts.body,
    fontSize:   14,
    color:      tokens.textSecondary,
    textAlign:  'center',
    lineHeight: 22,
  },
});

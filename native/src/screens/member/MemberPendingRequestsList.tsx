/**
 * MemberPendingRequestsList — CHW-proposed pending session requests awaiting
 * this member's approval, shown as a card above the calendar/dashboard.
 *
 * Mirrors CHWCalendarScreen's `PendingRequestsList` (Approve / Decline /
 * Propose New Time), adapted for the member POV:
 *  - Shows the CHW's name (not a member name).
 *  - Approve/Decline hit the SAME useConfirmSession/useDeclineSession
 *    mutations the CHW side uses — the member is just the caller now. The
 *    backend's "initiator inversion" rule (only the party who did NOT
 *    propose the session may confirm/decline it) is what makes this safe:
 *    a member can only act on a session `proposedBy: 'chw'`.
 *  - Filter is INTENTIONALLY exclusive of null/legacy `proposedBy` (unlike
 *    the CHW-side filter, which is inclusive of null/legacy) — a member
 *    should never see/act on a legacy pending row whose initiator is
 *    unknown, per the safe-default rule.
 *  - Decline shows an on-brand confirm Modal first (never window.confirm),
 *    matching CHWCalendarScreen's RemoveSessionConfirmModal pattern.
 *  - "Propose New Time" books the new pending session FIRST via
 *    useScheduleSession (chwId set, so the backend sets proposed_by:
 *    'member'), and only on success declines the OLD session via
 *    useDeclineSession — mirroring CHWCalendarScreen's ScheduleSessionModal
 *    replaceSessionId ordering exactly, so a failed re-book never loses the
 *    original request.
 *
 * Shared between MemberCalendarScreen (mounted above the calendar) and
 * MemberHomeScreen (mounted above the dashboard hero) rather than duplicated
 * in both files.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { AlertCircle, X } from 'lucide-react-native';

import { colors as tokens, spacing, radius } from '../../theme/tokens';
import { Card } from '../../components/ui';
import {
  useConfirmSession,
  useDeclineSession,
  useScheduleSession,
  type SessionData,
} from '../../hooks/useApiQueries';

// ─── Formatting helpers (ported — see MemberCalendarScreen's own module
// docstring for why these are copied rather than imported across screens) ──

function sessionModeLabel(mode?: string): string {
  if (mode === 'phone') return 'Phone Session';
  if (mode === 'virtual') return 'Video Session';
  if (mode === 'in_person') return 'In-Person Session';
  return 'Session';
}

function chwDisplayName(chwName?: string): string {
  return chwName && chwName.trim().length > 0 ? chwName : 'Your CHW';
}

function formatTimeAMPM(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h >= 12 ? 'PM' : 'AM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${String(m).padStart(2, '0')} ${suffix}`;
}

function formatTimeRange(startIso: string, endIso?: string | null): string {
  const start = formatTimeAMPM(startIso);
  if (!endIso) return start;
  const end = formatTimeAMPM(endIso);
  return `${start} – ${end}`;
}

function formatDateLabel(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** "MM/DD/YYYY" — matches ProposeNewTimeModal's own Date TextInput format. */
function formatDateInputValue(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/**
 * Parses "MM/DD/YYYY" and "HH:MM AM/PM" into a combined ISO string.
 * Returns null on parse failure.
 */
function parseDateTime(datePart: string, timePart: string): string | null {
  try {
    const [mm, dd, yyyy] = datePart.split('/').map(Number);
    if (!mm || !dd || !yyyy || isNaN(mm) || isNaN(dd) || isNaN(yyyy)) return null;

    const timeMatch = timePart.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!timeMatch) return null;

    let hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);
    const meridiem = timeMatch[3].toUpperCase();

    if (meridiem === 'AM' && hour === 12) hour = 0;
    if (meridiem === 'PM' && hour !== 12) hour += 12;

    const d = new Date(yyyy, mm - 1, dd, hour, minute, 0);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

// ─── Filter helper ─────────────────────────────────────────────────────────

/**
 * CHW-proposed pending sessions awaiting this member's approval, soonest
 * first. Exported so both mount points (MemberCalendarScreen,
 * MemberHomeScreen) derive the same list from their own `useSessions()` data
 * without duplicating the filter predicate.
 *
 * Deliberately EXCLUDES proposedBy null/undefined (legacy rows) — the
 * opposite of the CHW-side filter, which includes them. A member should not
 * see/act on a pending session whose initiator is unknown.
 */
export function selectMemberPendingRequests(sessions: SessionData[]): SessionData[] {
  return sessions
    .filter(
      (s) =>
        s.status === 'scheduled' &&
        s.schedulingStatus === 'pending' &&
        s.proposedBy === 'chw',
    )
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
}

// ─── Decline confirm modal (on-brand — mirrors CHWCalendarScreen's
// RemoveSessionConfirmModal, never window.confirm/Alert.alert) ────────────

interface DeclineConfirmModalProps {
  visible: boolean;
  chwName: string;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeclineConfirmModal({
  visible,
  chwName,
  isPending,
  onConfirm,
  onCancel,
}: DeclineConfirmModalProps): React.JSX.Element {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      accessibilityViewIsModal
    >
      <View style={confirmModalStyles.overlay}>
        <View style={confirmModalStyles.dialog}>
          <Text style={confirmModalStyles.title}>Decline this session request?</Text>
          <Text style={confirmModalStyles.body}>
            {chwDisplayName(chwName)} will be notified. This can't be undone.
          </Text>
          <View style={confirmModalStyles.actions}>
            <TouchableOpacity
              style={confirmModalStyles.cancelBtn}
              onPress={onCancel}
              disabled={isPending}
              accessibilityRole="button"
              accessibilityLabel="No, keep request"
            >
              <Text style={confirmModalStyles.cancelBtnText}>No, Keep It</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[confirmModalStyles.confirmBtn, isPending && { opacity: 0.6 }]}
              onPress={onConfirm}
              disabled={isPending}
              accessibilityRole="button"
              accessibilityLabel="Yes, decline request"
            >
              {isPending ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={confirmModalStyles.confirmBtnText}>Yes, Decline</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const confirmModalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  dialog: {
    backgroundColor: '#FFFFFF',
    borderRadius: radius.xl,
    padding: spacing.xl,
    width: '100%',
    maxWidth: 400,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 32,
    elevation: 12,
  },
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 17,
    color: '#1E3320',
    marginBottom: spacing.sm,
  },
  body: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 20,
    marginBottom: spacing.xl,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  cancelBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#374151',
  },
  confirmBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: '#DC2626',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  confirmBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
});

// ─── Propose New Time modal ─────────────────────────────────────────────────

interface ProposeNewTimeModalProps {
  visible: boolean;
  onClose: () => void;
  /** The CHW-proposed pending request being countered. Its chwId/scheduledAt
   *  seed the form; its id is declined ONLY after the new booking succeeds. */
  request: SessionData | null;
}

/**
 * Member's counter-offer flow for a CHW-proposed pending session — mirrors
 * CHWCalendarScreen's ScheduleSessionModal `replaceSessionId` mode: the new
 * (pending) session is booked FIRST via useScheduleSession (chwId set, so the
 * backend records proposed_by: 'member'), and ONLY on success is the original
 * request declined via useDeclineSession. A failed re-book never touches the
 * original pending request.
 */
function ProposeNewTimeModal({
  visible,
  onClose,
  request,
}: ProposeNewTimeModalProps): React.JSX.Element {
  const { mutateAsync, isPending } = useScheduleSession();
  const declineOldSession = useDeclineSession();

  const [dateInput, setDateInput] = useState('');
  const [startTimeInput, setStartTimeInput] = useState('');
  const [endTimeInput, setEndTimeInput] = useState('');
  const [mode, setMode] = useState<'in_person' | 'virtual' | 'phone'>('in_person');
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Seed the form from the request's CHW + scheduled time whenever the modal
  // opens. The modal stays mounted between opens (visible toggles), so this
  // can't just be an initializer — it must re-run each time `visible` flips
  // true, mirroring CHWCalendarScreen's ScheduleSessionModal prefill effect.
  useEffect(() => {
    if (!visible || !request) return;
    setDateInput(formatDateInputValue(request.scheduledAt));
    setStartTimeInput(formatTimeAMPM(request.scheduledAt));
    setEndTimeInput(
      request.scheduledEndAt ? formatTimeAMPM(request.scheduledEndAt) : formatTimeAMPM(request.scheduledAt),
    );
    setMode((request.mode as 'in_person' | 'virtual' | 'phone') ?? 'in_person');
    setFieldError(null);
  }, [visible, request]);

  const handleClose = useCallback(() => {
    setFieldError(null);
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(async () => {
    setFieldError(null);
    if (!request) return;

    const scheduledAt = parseDateTime(dateInput, startTimeInput);
    if (!scheduledAt) {
      setFieldError('Invalid date or start time. Use MM/DD/YYYY and "10:00 AM" format.');
      return;
    }
    const scheduledEndAt = parseDateTime(dateInput, endTimeInput);
    if (!scheduledEndAt) {
      setFieldError('Invalid end time. Use "11:00 AM" format.');
      return;
    }
    if (new Date(scheduledEndAt) <= new Date(scheduledAt)) {
      setFieldError('End time must be after start time.');
      return;
    }

    try {
      await mutateAsync({
        chwId: request.chwId,
        scheduledAt,
        scheduledEndAt,
        mode,
        schedulingStatus: 'pending',
      });
      // Only after the new booking succeeds do we decline the original
      // pending request, so a failed re-book never leaves the member with no
      // session at all — same ordering as CHWCalendarScreen's
      // ScheduleSessionModal replaceSessionId flow.
      try {
        await declineOldSession.mutateAsync(request.id);
      } catch {
        // Non-fatal — the new session booked successfully; the stale pending
        // request can be declined manually. declineOldSession surfaces its
        // own error alert.
      }
      handleClose();
    } catch {
      // Error alert handled by useScheduleSession's onError.
    }
  }, [request, dateInput, startTimeInput, endTimeInput, mode, mutateAsync, declineOldSession, handleClose]);

  const canSubmit = !!request && !isPending && !declineOldSession.isPending;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
      accessibilityViewIsModal
    >
      <View style={proposeModalStyles.overlay}>
        <View style={proposeModalStyles.sheet}>
          <View style={proposeModalStyles.header}>
            <Text style={proposeModalStyles.headerTitle}>Propose New Time</Text>
            <TouchableOpacity
              style={proposeModalStyles.closeBtn}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel="Close propose new time modal"
            >
              <X size={18} color={tokens.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={proposeModalStyles.body}>
            <Text style={proposeModalStyles.hint}>
              Sent as a new pending request — {chwDisplayName(request?.chwName)} will need to
              confirm this time.
            </Text>

            <View style={proposeModalStyles.field}>
              <Text style={proposeModalStyles.fieldLabel}>Date</Text>
              <TextInput
                style={proposeModalStyles.textInput}
                value={dateInput}
                onChangeText={setDateInput}
                placeholder="MM/DD/YYYY"
                placeholderTextColor="#9CA3AF"
                accessibilityLabel="Session date"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <View style={proposeModalStyles.timeRow}>
              <View style={[proposeModalStyles.field, { flex: 1 }]}>
                <Text style={proposeModalStyles.fieldLabel}>Start Time</Text>
                <TextInput
                  style={proposeModalStyles.textInput}
                  value={startTimeInput}
                  onChangeText={setStartTimeInput}
                  placeholder="10:00 AM"
                  placeholderTextColor="#9CA3AF"
                  accessibilityLabel="Session start time"
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
              </View>
              <View style={[proposeModalStyles.field, { flex: 1 }]}>
                <Text style={proposeModalStyles.fieldLabel}>End Time</Text>
                <TextInput
                  style={proposeModalStyles.textInput}
                  value={endTimeInput}
                  onChangeText={setEndTimeInput}
                  placeholder="11:00 AM"
                  placeholderTextColor="#9CA3AF"
                  accessibilityLabel="Session end time"
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
              </View>
            </View>

            {fieldError != null ? (
              <View style={proposeModalStyles.errorBanner}>
                <AlertCircle size={14} color="#B91C1C" />
                <Text style={proposeModalStyles.errorText}>{fieldError}</Text>
              </View>
            ) : null}
          </View>

          <View style={proposeModalStyles.footer}>
            <TouchableOpacity
              style={proposeModalStyles.cancelBtn}
              onPress={handleClose}
              accessibilityRole="button"
            >
              <Text style={proposeModalStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[proposeModalStyles.submitBtn, !canSubmit && proposeModalStyles.submitBtnDisabled]}
              onPress={() => void handleSubmit()}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityLabel="Propose new time"
              accessibilityState={{ disabled: !canSubmit }}
            >
              {isPending || declineOldSession.isPending ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={proposeModalStyles.submitText}>Propose New Time</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const proposeModalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderRadius: radius.xl,
    width: '100%',
    maxWidth: Platform.OS === 'web' ? 480 : undefined,
    maxHeight: '90%',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 32,
    elevation: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  headerTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: '#1E3320',
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: '#F9FAFB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    padding: spacing.xl,
    gap: spacing.lg,
  },
  hint: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 18,
  },
  field: {
    gap: spacing.xs,
  },
  fieldLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#374151',
    letterSpacing: 0.2,
  },
  textInput: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#1E3320',
    backgroundColor: '#FFFFFF',
    minHeight: 44,
  },
  timeRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  errorText: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#B91C1C',
  },
  footer: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.xl,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  cancelBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#FFFFFF',
    minHeight: 44,
  },
  cancelText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#374151',
  },
  submitBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: tokens.primary,
    minHeight: 44,
  },
  submitBtnDisabled: {
    opacity: 0.6,
  },
  submitText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
});

// ─── Main widget ─────────────────────────────────────────────────────────────

export interface MemberPendingRequestsListProps {
  /** Pre-filtered CHW-proposed pending requests — pass the output of
   *  `selectMemberPendingRequests(sessions)`. */
  requests: SessionData[];
}

/**
 * CHW-proposed (pending) sessions awaiting this member's approval, listed
 * above the calendar/dashboard. Each row can be Approved (→ confirmed) or
 * Declined (→ cancelled, behind an on-brand confirm dialog) inline via
 * useConfirmSession / useDeclineSession — the same mutations the CHW side
 * uses, now called by the member. "Propose New Time" opens a counter-offer
 * modal pre-filled with this request's time (see ProposeNewTimeModal) so the
 * member can suggest a different slot instead of just approving or
 * declining.
 */
export function MemberPendingRequestsList({
  requests,
}: MemberPendingRequestsListProps): React.JSX.Element | null {
  const confirmSession = useConfirmSession();
  const declineSession = useDeclineSession();
  const busy = confirmSession.isPending || declineSession.isPending;

  const [declineTarget, setDeclineTarget] = useState<SessionData | null>(null);
  const [proposeTarget, setProposeTarget] = useState<SessionData | null>(null);

  const handleConfirmDecline = useCallback(() => {
    if (!declineTarget) return;
    const target = declineTarget;
    void declineSession
      .mutateAsync(target.id)
      .catch(() => {})
      .finally(() => setDeclineTarget(null));
  }, [declineTarget, declineSession]);

  if (requests.length === 0) return null;

  return (
    <>
      <Card style={pendingStyles.card}>
        <Text style={pendingStyles.title}>Pending Session Requests ({requests.length})</Text>
        <Text style={pendingStyles.subtitle}>
          Your CHW proposed these times — approve, decline, or suggest a different time.
        </Text>
        {requests.map((r) => (
          <View key={r.id} style={pendingStyles.row}>
            <View style={pendingStyles.info}>
              <Text style={pendingStyles.name} numberOfLines={1}>
                {chwDisplayName(r.chwName)}
              </Text>
              <Text style={pendingStyles.meta} numberOfLines={2}>
                {formatDateLabel(r.scheduledAt)} ·{' '}
                {formatTimeRange(r.scheduledAt, r.scheduledEndAt)} ·{' '}
                {sessionModeLabel(r.mode)}
              </Text>
            </View>
            <View style={pendingStyles.actions}>
              <TouchableOpacity
                style={[pendingStyles.proposeBtn, busy && { opacity: 0.6 }]}
                disabled={busy}
                onPress={() => setProposeTarget(r)}
                accessibilityRole="button"
                accessibilityLabel={`Propose new time for ${chwDisplayName(r.chwName)}`}
              >
                <Text style={pendingStyles.proposeText}>Propose New Time</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[pendingStyles.declineBtn, busy && { opacity: 0.6 }]}
                disabled={busy}
                onPress={() => setDeclineTarget(r)}
                accessibilityRole="button"
                accessibilityLabel={`Decline request from ${chwDisplayName(r.chwName)}`}
              >
                <Text style={pendingStyles.declineText}>Decline</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[pendingStyles.approveBtn, busy && { opacity: 0.6 }]}
                disabled={busy}
                onPress={() => {
                  void confirmSession.mutateAsync(r.id).catch(() => {});
                }}
                accessibilityRole="button"
                accessibilityLabel={`Approve request from ${chwDisplayName(r.chwName)}`}
              >
                <Text style={pendingStyles.approveText}>Approve</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </Card>

      <DeclineConfirmModal
        visible={declineTarget !== null}
        chwName={declineTarget?.chwName ?? ''}
        isPending={declineSession.isPending}
        onCancel={() => setDeclineTarget(null)}
        onConfirm={handleConfirmDecline}
      />

      <ProposeNewTimeModal
        visible={proposeTarget !== null}
        onClose={() => setProposeTarget(null)}
        request={proposeTarget}
      />
    </>
  );
}

const pendingStyles = StyleSheet.create({
  card: {
    marginTop: spacing.lg,
    padding: spacing.lg,
  },
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#1E3320',
  },
  subtitle: {
    fontSize: 13,
    color: tokens.textSecondary,
    marginTop: 2,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    flexWrap: 'wrap',
  },
  info: {
    flex: 1,
    minWidth: 160,
  },
  name: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.textPrimary,
  },
  meta: {
    fontSize: 12,
    color: tokens.textSecondary,
    marginTop: 2,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  proposeBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#FFFFFF',
  },
  proposeText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  declineBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    backgroundColor: '#FEF2F2',
  },
  declineText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#b91c1c',
  },
  approveBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: tokens.primary,
  },
  approveText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});

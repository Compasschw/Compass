/**
 * MemberPendingRequestsList — CHW-proposed pending session requests awaiting
 * this member's approval, shown as a card above the calendar/dashboard.
 *
 * Mirrors CHWCalendarScreen's `PendingRequestsList` (Approve / Propose New
 * Time), adapted for the member POV:
 *  - Shows the CHW's name (not a member name).
 *  - Approve hits the SAME useConfirmSession mutation the CHW side uses —
 *    the member is just the caller now. The backend's "initiator inversion"
 *    rule (only the party who did NOT propose the session may confirm it)
 *    is what makes this safe: a member can only act on a session
 *    `proposedBy: 'chw'`.
 *  - Filter is INTENTIONALLY exclusive of null/legacy `proposedBy` (unlike
 *    the CHW-side filter, which is inclusive of null/legacy) — a member
 *    should never see/act on a legacy pending row whose initiator is
 *    unknown, per the safe-default rule.
 *  - QA2 A2 #14/#18 — the Decline button was REMOVED from this list (product
 *    decision): a member's only actions on a CHW-proposed pending request
 *    are Approve and Propose New Time. The backend decline endpoint is left
 *    completely untouched — ProposeNewTimeModal below still calls
 *    useDeclineSession internally as the "retract the old request" second
 *    step of the propose flow, it's just no longer exposed as a standalone
 *    row action.
 *  - "Propose New Time" books the new pending session FIRST via
 *    useScheduleSession (chwId set, so the backend sets proposed_by:
 *    'member'), and only on success declines the OLD session via
 *    useDeclineSession — mirroring CHWCalendarScreen's ScheduleSessionModal
 *    replaceSessionId ordering exactly, so a failed re-book never loses the
 *    original request. QA2 A2 #3 — the counter-offer also carries a Resource
 *    Needs multiselect, seeded from the original request, so proposing a new
 *    time doesn't silently drop needs already on record.
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
import {
  VERTICAL_PICKER_OPTIONS,
  VERTICAL_COLOR,
  type Vertical,
} from '../../lib/verticals';
import { showAlert } from '../../utils/showAlert';

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
  // Phone is the default type (QA batch 2026-07-14 #23), matching
  // MemberCalendarScreen's schedule dialog. This modal has no Type picker UI
  // of its own — `mode` is normally overwritten by the prefill effect below
  // from the original request's mode the instant it opens — so this initial
  // value and the effect's fallback only matter for the rare request that
  // somehow has no mode recorded.
  const [mode, setMode] = useState<'in_person' | 'virtual' | 'phone'>('phone');
  // QA2 A2 #3 — Resource Needs multiselect, mirroring CHWCalendarScreen's
  // ScheduleSessionModal chip grid exactly (same VERTICAL_PICKER_OPTIONS
  // source of truth, same Set-based toggle). Seeded from the original
  // request below so counter-offering a new time doesn't drop needs already
  // on record.
  const [resourceNeeds, setResourceNeeds] = useState<Set<Vertical>>(new Set());
  const [fieldError, setFieldError] = useState<string | null>(null);

  const toggleResourceNeed = useCallback((v: Vertical) => {
    setResourceNeeds((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }, []);

  // Seed the form from the request's CHW + scheduled time + resource needs
  // whenever the modal opens. The modal stays mounted between opens (visible
  // toggles), so this can't just be an initializer — it must re-run each
  // time `visible` flips true, mirroring CHWCalendarScreen's
  // ScheduleSessionModal prefill effect.
  useEffect(() => {
    if (!visible || !request) return;
    setDateInput(formatDateInputValue(request.scheduledAt));
    setStartTimeInput(formatTimeAMPM(request.scheduledAt));
    setEndTimeInput(
      request.scheduledEndAt ? formatTimeAMPM(request.scheduledEndAt) : formatTimeAMPM(request.scheduledAt),
    );
    setMode((request.mode as 'in_person' | 'virtual' | 'phone') ?? 'phone');
    setResourceNeeds(new Set((request.resourceNeeds as Vertical[] | null | undefined) ?? []));
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
        resourceNeeds: Array.from(resourceNeeds),
      });
      // Only after the new booking succeeds do we decline the original
      // pending request, so a failed re-book never leaves the member with no
      // session at all — same ordering as CHWCalendarScreen's
      // ScheduleSessionModal replaceSessionId flow.
      try {
        await declineOldSession.mutateAsync(request.id);
      } catch (declineErr) {
        // QA2 A2 #2 — surface this instead of swallowing it silently: the
        // new session booked successfully, but the stale original is still
        // live and needs manual cleanup. Log for diagnostics and show a
        // non-blocking warning (the new booking already succeeded, so this
        // must not block handleClose() below).
        console.error(
          '[ProposeNewTimeModal] Failed to decline the original session after a successful Propose New Time re-book:',
          declineErr,
        );
        showAlert(
          'New time proposed, but the old request is still pending',
          'The new session was booked, but we could not automatically remove the original request. Please decline it manually.',
        );
      }
      handleClose();
    } catch {
      // Error alert handled by useScheduleSession's onError.
    }
  }, [
    request,
    dateInput,
    startTimeInput,
    endTimeInput,
    mode,
    resourceNeeds,
    mutateAsync,
    declineOldSession,
    handleClose,
  ]);

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

            {/* Resource Needs (optional) — QA2 A2 #3: reuses lib/verticals.ts
                as the single source of truth, exactly like CHWCalendarScreen's
                ScheduleSessionModal chip grid, seeded from the original
                request (see the prefill effect above). */}
            <View style={proposeModalStyles.field}>
              <Text style={proposeModalStyles.fieldLabel}>Resource Needs (optional)</Text>
              <View style={proposeModalStyles.chipRow} accessibilityLabel="Resource needs">
                {VERTICAL_PICKER_OPTIONS.map((opt) => {
                  const isSelected = resourceNeeds.has(opt.key);
                  const color = VERTICAL_COLOR[opt.key];
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      style={[
                        proposeModalStyles.chip,
                        isSelected && {
                          backgroundColor: `${color}1A`,
                          borderColor: color,
                        },
                      ]}
                      onPress={() => toggleResourceNeed(opt.key)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={opt.label}
                    >
                      <Text style={proposeModalStyles.chipEmoji}>{opt.emoji}</Text>
                      <Text
                        style={[
                          proposeModalStyles.chipText,
                          isSelected && { color, fontFamily: 'PlusJakartaSans_600SemiBold' },
                        ]}
                      >
                        {opt.label}
                      </Text>
                      {isSelected ? (
                        <Text style={[proposeModalStyles.chipCheck, { color }]}>✓</Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
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
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#FFFFFF',
  },
  chipEmoji: {
    fontSize: 14,
  },
  chipText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#374151',
  },
  chipCheck: {
    fontFamily: 'PlusJakartaSans_700Bold',
    fontSize: 13,
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
 * above the calendar/dashboard. Each row can be Approved (→ confirmed)
 * inline via useConfirmSession — the same mutation the CHW side uses, now
 * called by the member. "Propose New Time" opens a counter-offer modal
 * pre-filled with this request's time + resource needs (see
 * ProposeNewTimeModal) so the member can suggest a different slot instead of
 * just approving. QA2 A2 #14/#18 — the standalone Decline action was removed
 * from this row (product decision); useDeclineSession is still used
 * internally by ProposeNewTimeModal to retract the old request as step 2 of
 * the propose flow.
 */
export function MemberPendingRequestsList({
  requests,
}: MemberPendingRequestsListProps): React.JSX.Element | null {
  const confirmSession = useConfirmSession();
  const busy = confirmSession.isPending;

  const [proposeTarget, setProposeTarget] = useState<SessionData | null>(null);

  if (requests.length === 0) return null;

  return (
    <>
      <Card style={pendingStyles.card}>
        <Text style={pendingStyles.title}>Pending Session Requests ({requests.length})</Text>
        <Text style={pendingStyles.subtitle}>
          Your CHW proposed these times — approve or suggest a different time.
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

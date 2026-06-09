/**
 * CHWCalendarScreen — Full-width calendar grid with Schedule Session modal.
 *
 * Features:
 *  - Day/Week/Month toggle in header
 *  - Week view: 7 columns × hourly rows 8 AM–6 PM, today highlighted (web default)
 *  - Month view: 7-column grid with member-count badges (all platforms)
 *  - "Schedule Session" CTA in the page header — opens a modal to schedule a new
 *    session from an accepted service request (POSTs to POST /api/v1/sessions/).
 *  - No right-side rail — calendar grid occupies full screen width.
 *  - Tap a day/slot to reveal events in detail panel
 *  - Color-coded legend for member journey statuses
 */

import React, {
  useState,
  useMemo,
  useCallback,
  useRef,
} from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Platform,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Clock,
  MapPin,
  Target,
  Plus,
  X,
} from 'lucide-react-native';

import { colors as tokens, spacing, radius } from '../../theme/tokens';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import {
  verticalLabels,
  type CalendarEvent,
  type Vertical,
} from '../../data/mock';
import {
  AppShell,
  PageHeader,
  Card,
  SectionHeader,
} from '../../components/ui';
import {
  useSessions,
  useRequests,
  useCreateSession,
  type SessionData,
  type ServiceRequestData,
} from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';

// ─── Member need-journey status (mocked) — see CHWDashboardScreen ─────────────
// TODO(backend): expose journey_status per session.
type JourneyStatus = 'starting' | 'awaiting_confirmation' | 'resolved';
const JOURNEY_COLORS: Record<JourneyStatus, string> = {
  starting: '#EF4444',
  awaiting_confirmation: '#F59E0B',
  resolved: '#22C55E',
};
const JOURNEY_LABELS: Record<JourneyStatus, string> = {
  starting: 'Starting',
  awaiting_confirmation: 'Awaiting confirmation',
  resolved: 'Resolved',
};
function mockJourneyStatus(id: string): JourneyStatus {
  const sum = id.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const idx = sum % 3;
  return idx === 0 ? 'starting' : idx === 1 ? 'awaiting_confirmation' : 'resolved';
}
const JOURNEY_DESCRIPTIONS: Record<JourneyStatus, string> = {
  starting: 'Just started finding the resource',
  awaiting_confirmation: 'Resources shared — waiting on member',
  resolved: 'Resources used and member moved on',
};

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_LABELS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const VERTICAL_COLORS: Record<Vertical | 'goal_milestone', string> = {
  housing: '#3B82F6',
  rehab: '#EF4444',
  food: '#F59E0B',
  mental_health: '#8B5CF6',
  healthcare: '#06B6D4',
  goal_milestone: colors.secondary,
};

/** Hours displayed in the week-view grid (8 AM – 6 PM inclusive = 11 slots). */
const WEEK_VIEW_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

type CalendarViewMode = 'day' | 'week' | 'month';

type SessionModality = 'in_person' | 'virtual';

const MODALITY_LABELS: Record<SessionModality, string> = {
  in_person: 'In-Person',
  virtual: 'Virtual',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns 7-aligned cell array for the given month.
 * Null pads the leading days to align to the correct weekday column.
 */
function getMonthCells(year: number, month: number): (number | null)[] {
  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = Array(firstDayOfWeek).fill(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/** Returns the 7-day Date[] for the ISO week containing the given date. */
function getWeekDays(anchor: Date): Date[] {
  const day = anchor.getDay(); // 0=Sun
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - day + (day === 0 ? -6 : 1));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

/** Formats YYYY-MM-DD key from year/month/day. */
function toDateKey(year: number, month: number, day: number): string {
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** Formats a Date to YYYY-MM-DD. */
function dateToKey(d: Date): string {
  return toDateKey(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Groups CalendarEvent[] by their `date` field into a Map<string, CalendarEvent[]>. */
function groupByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const bucket = map.get(event.date) ?? [];
    map.set(event.date, [...bucket, event]);
  }
  return map;
}

/**
 * Derives CalendarEvent records from the sessions array.
 */
function deriveSessionEvents(sessions: SessionData[]): CalendarEvent[] {
  return sessions.map((session) => {
    const dt = new Date(session.scheduledAt);
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    const date = `${dt.getUTCFullYear()}-${mm}-${dd}`;
    const hh = String(dt.getUTCHours()).padStart(2, '0');
    const min = String(dt.getUTCMinutes()).padStart(2, '0');
    const endHour = String(dt.getUTCHours() + 1).padStart(2, '0');

    return {
      id: `derived-${session.id}`,
      title: `Session: ${session.memberName ?? 'Member'}`,
      date,
      startTime: `${hh}:${min}`,
      endTime: `${endHour}:${min}`,
      vertical: session.vertical as Vertical | undefined,
      type: 'session' as const,
      chwName: session.chwName,
      memberName: session.memberName,
    };
  });
}

/**
 * Resolves the dot color for a calendar event.
 */
function eventColor(event: CalendarEvent): string {
  if (event.vertical) return VERTICAL_COLORS[event.vertical];
  return VERTICAL_COLORS.goal_milestone;
}

/**
 * Formats HH:MM 24h → "2:00 PM"
 */
function formatTimeFull(time: string): string {
  const [hourStr, minuteStr] = time.split(':');
  const hour = parseInt(hourStr, 10);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${minuteStr} ${suffix}`;
}

/**
 * Formats an hour integer (24h) → "8 AM" / "12 PM" etc.
 */
function formatHourLabel(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

/**
 * Converts a local Date to an ISO-8601 string suitable for datetime-local inputs
 * and backend scheduled_at payloads (UTC).
 */
function toISODateTimeLocal(date: Date): string {
  // Returns YYYY-MM-DDTHH:mm (local time, for <input type="datetime-local">)
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Formats a local datetime-local string to a display-friendly label.
 * Input: "2026-06-15T14:30" → "Jun 15, 2026 at 2:30 PM"
 */
function formatDateTimeLabel(value: string): string {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' at ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ─── EventDetailCard sub-component ───────────────────────────────────────────

interface EventDetailCardProps {
  event: CalendarEvent;
}

function EventDetailCard({ event }: EventDetailCardProps): React.JSX.Element {
  const barColor = eventColor(event);
  const isSession = event.type === 'session';
  const journey = mockJourneyStatus(event.id);

  return (
    <View style={detailStyles.card}>
      <View style={[detailStyles.colorStrip, { backgroundColor: barColor }]} />
      <View style={detailStyles.cardBody}>
        <View style={detailStyles.titleRow}>
          <Text style={detailStyles.title} numberOfLines={2}>
            {event.title}
          </Text>
          {event.vertical ? (
            <View style={[detailStyles.badge, { backgroundColor: barColor + '20' }]}>
              <Text style={[detailStyles.badgeText, { color: barColor }]}>
                {verticalLabels[event.vertical]}
              </Text>
            </View>
          ) : null}
          {/* Journey-status pill — same dashboard treatment per Jemal */}
          {isSession ? (
            <View style={detailStyles.journeyPill}>
              <View style={[detailStyles.journeyDot, { backgroundColor: JOURNEY_COLORS[journey] }]} />
              <Text style={detailStyles.journeyText}>{JOURNEY_LABELS[journey]}</Text>
            </View>
          ) : null}
        </View>

        <View style={detailStyles.metaRow}>
          <Clock size={12} color={colors.mutedForeground} />
          <Text style={detailStyles.metaText}>
            {formatTimeFull(event.startTime)}
            {event.endTime !== event.startTime
              ? ` – ${formatTimeFull(event.endTime)}`
              : ''}
          </Text>
        </View>

        {event.memberName ? (
          <View style={detailStyles.metaRow}>
            <CalendarDays size={12} color={colors.mutedForeground} />
            <Text style={detailStyles.metaText}>
              {event.memberName}
              {isSession && event.chwName ? ` · ${event.chwName}` : ''}
            </Text>
          </View>
        ) : null}

        {/* Member address — TODO(backend): expose member.address on SessionData */}
        {isSession ? (
          <View style={detailStyles.metaRow}>
            <MapPin size={12} color={colors.mutedForeground} />
            <Text style={detailStyles.metaText}>1834 W 6th St, Los Angeles, CA 90057</Text>
          </View>
        ) : null}

        {/* Quick-action goal note — TODO(backend): expose session.goal_note */}
        {isSession ? (
          <View style={detailStyles.actionNote}>
            <Target size={12} color={colors.primary} />
            <Text style={detailStyles.actionNoteText}>
              Goal: walk through Medi-Cal renewal paperwork together.
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const detailStyles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    flexDirection: 'row',
    overflow: 'hidden',
    marginBottom: 10,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  colorStrip: {
    width: 4,
    flexShrink: 0,
  },
  cardBody: {
    flex: 1,
    padding: 14,
    gap: 6,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
  },
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    lineHeight: 20,
    color: '#1E3320',
    flex: 1,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
    flexShrink: 0,
  },
  badgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    lineHeight: 16,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metaText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
    flex: 1,
  },
  journeyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
    backgroundColor: '#F4F1ED',
    borderWidth: 1,
    borderColor: '#DDD6CC',
    flexShrink: 0,
  },
  journeyDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  journeyText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#6B7A6B',
  },
  actionNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.primary + '0D',
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
  },
  actionNoteText: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: colors.foreground,
    lineHeight: 16,
  },
});

// ─── WeekViewGrid — web-only ──────────────────────────────────────────────────

interface WeekViewGridProps {
  weekDays: Date[];
  eventsByDate: Map<string, CalendarEvent[]>;
  today: { year: number; month: number; day: number };
  onSlotPress: (date: Date, hour: number) => void;
}

/**
 * 7-column × hourly-row week-view grid. Matches the appointments.html mockup:
 * each cell is 48px tall, today's column highlighted in a pale tint, events
 * rendered as colored chips inside their hour slot.
 */
function WeekViewGrid({
  weekDays,
  eventsByDate,
  today,
  onSlotPress,
}: WeekViewGridProps): React.JSX.Element {
  return (
    <ScrollView horizontal={false} showsVerticalScrollIndicator={false}>
      {/* Day header row */}
      <View style={weekStyles.headerRow}>
        {/* Time gutter header */}
        <View style={weekStyles.timeGutter} />
        {weekDays.map((date) => {
          const isToday =
            date.getFullYear() === today.year &&
            date.getMonth() === today.month &&
            date.getDate() === today.day;
          return (
            <View
              key={dateToKey(date)}
              style={[weekStyles.dayHeader, isToday && weekStyles.dayHeaderToday]}
            >
              <Text style={[weekStyles.dayHeaderLabel, isToday && weekStyles.dayHeaderLabelToday]}>
                {DAY_LABELS[date.getDay()]}
              </Text>
              <Text style={[weekStyles.dayHeaderDate, isToday && weekStyles.dayHeaderDateToday]}>
                {date.getDate()}
              </Text>
            </View>
          );
        })}
      </View>

      {/* Hourly rows */}
      {WEEK_VIEW_HOURS.map((hour) => (
        <View key={hour} style={weekStyles.hourRow}>
          {/* Time label */}
          <View style={weekStyles.timeGutter}>
            <Text style={weekStyles.timeLabel}>{formatHourLabel(hour)}</Text>
          </View>
          {/* Day columns */}
          {weekDays.map((date) => {
            const key = dateToKey(date);
            const dayEvents = (eventsByDate.get(key) ?? []).filter((e) => {
              const eventHour = parseInt(e.startTime.split(':')[0], 10);
              return eventHour === hour;
            });
            const isToday =
              date.getFullYear() === today.year &&
              date.getMonth() === today.month &&
              date.getDate() === today.day;

            return (
              <TouchableOpacity
                key={key + '-' + hour}
                style={[weekStyles.hourCell, isToday && weekStyles.hourCellToday]}
                onPress={() => onSlotPress(date, hour)}
                accessibilityRole="button"
                accessibilityLabel={`${DAY_LABELS_LONG[date.getDay()]} ${date.getDate()}, ${formatHourLabel(hour)}`}
              >
                {dayEvents.map((event) => {
                  const barColor = eventColor(event);
                  return (
                    <View
                      key={event.id}
                      style={[weekStyles.eventChip, { backgroundColor: barColor + '22', borderLeftColor: barColor }]}
                    >
                      <Text style={[weekStyles.eventChipText, { color: barColor }]} numberOfLines={1}>
                        {event.memberName ?? event.title}
                      </Text>
                    </View>
                  );
                })}
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}

const weekStyles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    borderBottomWidth: 2,
    borderBottomColor: '#DDD6CC',
    backgroundColor: '#FFFFFF',
  },
  timeGutter: {
    width: 64,
    paddingRight: 8,
    alignItems: 'flex-end',
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: '#F0EDE9',
  },
  timeLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: '#9CA3AF',
    paddingTop: 2,
  },
  dayHeader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRightWidth: 1,
    borderRightColor: '#F0EDE9',
    gap: 2,
  },
  dayHeaderToday: {
    backgroundColor: tokens.primary + '08',
  },
  dayHeaderLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: '#6B7A6B',
  },
  dayHeaderLabelToday: {
    color: tokens.primary,
  },
  dayHeaderDate: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: '#1E3320',
  },
  dayHeaderDateToday: {
    color: '#FFFFFF',
    backgroundColor: tokens.primary,
    width: 32,
    height: 32,
    borderRadius: 16,
    textAlign: 'center',
    lineHeight: 32,
    overflow: 'hidden',
  },
  hourRow: {
    flexDirection: 'row',
    height: 56,
    borderBottomWidth: 1,
    borderBottomColor: '#F0EDE9',
  },
  hourCell: {
    flex: 1,
    borderRightWidth: 1,
    borderRightColor: '#F0EDE9',
    padding: 2,
    gap: 2,
  },
  hourCellToday: {
    backgroundColor: tokens.primary + '05',
  },
  eventChip: {
    borderLeftWidth: 2,
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  eventChipText: {
    fontSize: 10,
    fontWeight: '600',
  },
});

// ─── ScheduleSessionModal ─────────────────────────────────────────────────────

interface ScheduleSessionModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
  acceptedRequests: ServiceRequestData[];
  isLoadingRequests: boolean;
}

/**
 * Modal for scheduling a new session from an accepted service request.
 *
 * Workflow:
 *  1. CHW selects a member (from their accepted service requests).
 *  2. Picks a date and time (datetime-local input on web; text input on native).
 *  3. Picks a modality (In-Person / Virtual).
 *  4. Submits — POSTs to POST /api/v1/sessions/.
 *
 * The `request_id` is resolved from the selected accepted request row.
 * The backend derives vertical, chw_id, and member_id from the request.
 */
function ScheduleSessionModal({
  visible,
  onClose,
  onSuccess,
  acceptedRequests,
  isLoadingRequests,
}: ScheduleSessionModalProps): React.JSX.Element {
  const { mutateAsync: createSession, isPending } = useCreateSession();

  const [selectedRequestId, setSelectedRequestId] = useState<string>('');
  const [scheduledAt, setScheduledAt] = useState<string>(() => {
    // Default to tomorrow at 10:00 AM local time
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    return toISODateTimeLocal(tomorrow);
  });
  const [modality, setModality] = useState<SessionModality>('in_person');
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Reset form when modal closes
  const handleClose = useCallback(() => {
    setSelectedRequestId('');
    setScheduledAt(() => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);
      return toISODateTimeLocal(tomorrow);
    });
    setModality('in_person');
    setFieldError(null);
    onClose();
  }, [onClose]);

  const selectedRequest = acceptedRequests.find((r) => r.id === selectedRequestId);

  const handleSubmit = useCallback(async () => {
    setFieldError(null);

    if (!selectedRequestId) {
      setFieldError('Please select a member.');
      return;
    }

    if (!scheduledAt) {
      setFieldError('Please select a date and time.');
      return;
    }

    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime())) {
      setFieldError('Invalid date/time. Please re-enter.');
      return;
    }

    if (scheduledDate <= new Date()) {
      setFieldError('Scheduled time must be in the future.');
      return;
    }

    try {
      await createSession({
        requestId: selectedRequestId,
        scheduledAt: scheduledDate.toISOString(),
        mode: modality,
      });
      handleClose();
      onSuccess();
    } catch {
      // Error alert is handled by useCreateSession's onError
    }
  }, [selectedRequestId, scheduledAt, modality, createSession, handleClose, onSuccess]);

  const canSubmit =
    selectedRequestId.length > 0 &&
    scheduledAt.length > 0 &&
    !isPending;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
      accessibilityViewIsModal
    >
      <View style={modalStyles.overlay}>
        <View style={modalStyles.sheet}>
          {/* Header */}
          <View style={modalStyles.header}>
            <Text style={modalStyles.headerTitle}>Schedule Session</Text>
            <TouchableOpacity
              style={modalStyles.closeBtn}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel="Close schedule session modal"
            >
              <X size={18} color={tokens.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={modalStyles.body}
            contentContainerStyle={modalStyles.bodyContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Member selector */}
            <View style={modalStyles.field}>
              <Text style={modalStyles.fieldLabel}>Member</Text>
              {isLoadingRequests ? (
                <View style={modalStyles.loadingRow}>
                  <ActivityIndicator size="small" color={tokens.primary} />
                  <Text style={modalStyles.loadingText}>Loading members...</Text>
                </View>
              ) : acceptedRequests.length === 0 ? (
                <View style={modalStyles.emptyHint}>
                  <Text style={modalStyles.emptyHintText}>
                    No accepted service requests. Accept a member request first before scheduling a session.
                  </Text>
                </View>
              ) : (
                <View style={modalStyles.memberList}>
                  {acceptedRequests.map((req) => {
                    const isActive = selectedRequestId === req.id;
                    return (
                      <TouchableOpacity
                        key={req.id}
                        style={[modalStyles.memberRow, isActive && modalStyles.memberRowActive]}
                        onPress={() => setSelectedRequestId(req.id)}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: isActive }}
                        accessibilityLabel={`Select ${req.memberName ?? 'member'}`}
                      >
                        <View style={[modalStyles.memberRadio, isActive && modalStyles.memberRadioActive]}>
                          {isActive ? <View style={modalStyles.memberRadioDot} /> : null}
                        </View>
                        <View style={modalStyles.memberInfo}>
                          <Text style={[modalStyles.memberName, isActive && modalStyles.memberNameActive]}>
                            {req.memberName ?? 'Unknown Member'}
                          </Text>
                          <Text style={modalStyles.memberMeta}>
                            {req.vertical
                              ? (verticalLabels[req.vertical as Vertical] ?? req.vertical)
                              : 'General'} · {req.preferredMode.replace('_', '-')}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </View>

            {/* Date & time */}
            <View style={modalStyles.field}>
              <Text style={modalStyles.fieldLabel}>Date &amp; Time</Text>
              {Platform.OS === 'web' ? (
                // Web: native datetime-local input
                <View style={modalStyles.dateInputWrapper}>
                  {/* @ts-ignore — datetime-local is a valid HTML input type on web */}
                  <TextInput
                    style={modalStyles.dateInput}
                    // @ts-ignore — type is a valid HTML attribute on web
                    type="datetime-local"
                    value={scheduledAt}
                    onChangeText={setScheduledAt}
                    accessibilityLabel="Scheduled date and time"
                  />
                </View>
              ) : (
                // Native: text input for datetime — YYYY-MM-DDTHH:mm format
                <View style={modalStyles.dateInputWrapper}>
                  <TextInput
                    style={modalStyles.dateInput}
                    value={scheduledAt}
                    onChangeText={setScheduledAt}
                    placeholder="YYYY-MM-DDTHH:mm (e.g. 2026-06-15T14:00)"
                    placeholderTextColor={tokens.textMuted}
                    accessibilityLabel="Scheduled date and time"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
              )}
              {scheduledAt.length > 0 && (
                <Text style={modalStyles.datePreview}>{formatDateTimeLabel(scheduledAt)}</Text>
              )}
            </View>

            {/* Modality */}
            <View style={modalStyles.field}>
              <Text style={modalStyles.fieldLabel}>Modality</Text>
              <View style={modalStyles.modalityRow}>
                {(['in_person', 'virtual'] as SessionModality[]).map((m) => {
                  const isActive = modality === m;
                  return (
                    <TouchableOpacity
                      key={m}
                      style={[modalStyles.modalityBtn, isActive && modalStyles.modalityBtnActive]}
                      onPress={() => setModality(m)}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: isActive }}
                      accessibilityLabel={MODALITY_LABELS[m]}
                    >
                      <Text style={[modalStyles.modalityText, isActive && modalStyles.modalityTextActive]}>
                        {MODALITY_LABELS[m]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Session type context (read-only, derived from request) */}
            {selectedRequest != null && (
              <View style={modalStyles.field}>
                <Text style={modalStyles.fieldLabel}>Session Type</Text>
                <View style={modalStyles.readonlyRow}>
                  <Text style={modalStyles.readonlyValue}>
                    {selectedRequest.vertical
                      ? (verticalLabels[selectedRequest.vertical as Vertical] ?? selectedRequest.vertical)
                      : 'General'}
                  </Text>
                  <Text style={modalStyles.readonlyHint}>Derived from service request</Text>
                </View>
              </View>
            )}

            {/* Inline field error */}
            {fieldError != null ? (
              <View style={modalStyles.errorBanner}>
                <Text style={modalStyles.errorText}>{fieldError}</Text>
              </View>
            ) : null}
          </ScrollView>

          {/* Footer actions */}
          <View style={modalStyles.footer}>
            <TouchableOpacity
              style={modalStyles.cancelBtn}
              onPress={handleClose}
              accessibilityRole="button"
            >
              <Text style={modalStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[modalStyles.submitBtn, !canSubmit && modalStyles.submitBtnDisabled]}
              onPress={() => void handleSubmit()}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityLabel="Confirm and schedule session"
              accessibilityState={{ disabled: !canSubmit }}
            >
              {isPending ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={modalStyles.submitText}>Schedule Session</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  sheet: {
    backgroundColor: tokens.cardBg,
    borderRadius: radius.xl,
    width: '100%',
    maxWidth: Platform.OS === 'web' ? 520 : undefined,
    maxHeight: '90%',
    overflow: 'hidden',
    // Shadow
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
    borderBottomColor: tokens.cardBorder,
  },
  headerTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: tokens.textPrimary,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: tokens.gray100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: spacing.xl,
    gap: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  field: {
    gap: spacing.sm,
  },
  fieldLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: tokens.textPrimary,
    letterSpacing: 0.3,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
  },
  loadingText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.textSecondary,
  },
  emptyHint: {
    backgroundColor: tokens.amber100,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  emptyHintText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.amber700,
    lineHeight: 18,
  },
  memberList: {
    gap: spacing.xs,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
  },
  memberRowActive: {
    borderColor: tokens.primary,
    backgroundColor: tokens.emerald100,
  },
  memberRadio: {
    width: 18,
    height: 18,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  memberRadioActive: {
    borderColor: tokens.primary,
  },
  memberRadioDot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: tokens.primary,
  },
  memberInfo: {
    flex: 1,
    gap: 2,
  },
  memberName: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: tokens.textPrimary,
  },
  memberNameActive: {
    color: tokens.emerald700,
  },
  memberMeta: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: tokens.textSecondary,
  },
  dateInputWrapper: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  dateInput: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: tokens.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: tokens.cardBg,
    minHeight: 44,
  },
  datePreview: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: tokens.textSecondary,
    marginTop: 2,
  },
  modalityRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  modalityBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    backgroundColor: tokens.cardBg,
  },
  modalityBtnActive: {
    borderColor: tokens.primary,
    backgroundColor: tokens.emerald100,
  },
  modalityText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: tokens.textSecondary,
  },
  modalityTextActive: {
    color: tokens.emerald700,
  },
  readonlyRow: {
    gap: 2,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: tokens.gray100,
    borderRadius: radius.md,
  },
  readonlyValue: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: tokens.textPrimary,
  },
  readonlyHint: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.textMuted,
  },
  errorBanner: {
    backgroundColor: tokens.red100,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  errorText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.red700,
  },
  footer: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.xl,
    borderTopWidth: 1,
    borderTopColor: tokens.cardBorder,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: tokens.textSecondary,
  },
  submitBtn: {
    flex: 2,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: tokens.primary,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  submitBtnDisabled: {
    backgroundColor: tokens.textMuted,
  },
  submitText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
});

// ─── Main Component ───────────────────────────────────────────────────────────

const now = new Date();
const TODAY_YEAR = now.getFullYear();
const TODAY_MONTH = now.getMonth();
const TODAY_DAY = now.getDate();

/**
 * CHW Calendar screen — full-width week/month view + Schedule Session modal.
 *
 * The right-side rail has been stripped per T12 spec. The calendar grid now
 * occupies 100% of the available width on both web and native.
 *
 * The "Schedule Session" CTA in the page header opens a modal that lets the
 * CHW pick a member from their accepted service requests, choose a date/time
 * and modality, then POST to /api/v1/sessions/.
 */
export function CHWCalendarScreen(): React.JSX.Element {
  const { data: rawSessions, isLoading, error, refetch } = useSessions();
  const { data: rawRequests, isLoading: isLoadingRequests } = useRequests();
  const refresh = useRefreshControl([refetch]);

  // View mode: web defaults to 'week', native stays 'month'
  const [viewMode, setViewMode] = useState<CalendarViewMode>(
    Platform.OS === 'web' ? 'week' : 'month',
  );

  // Default to today's month/week so the chart reflects real data on first open.
  const [currentDate, setCurrentDate] = useState(
    () => new Date(TODAY_YEAR, TODAY_MONTH, 1),
  );
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const cells = useMemo(() => getMonthCells(year, month), [year, month]);

  // Current week anchor: track a week anchor date (defaults to today).
  const [weekAnchor, setWeekAnchor] = useState(() => new Date(TODAY_YEAR, TODAY_MONTH, TODAY_DAY));
  const weekDays = useMemo(() => getWeekDays(weekAnchor), [weekAnchor]);

  // Schedule Session modal state
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);

  const allSessions = rawSessions ?? [];

  const allEvents = useMemo<CalendarEvent[]>(() => {
    return deriveSessionEvents(allSessions);
  }, [allSessions]);

  const eventsByDate = useMemo(() => groupByDate(allEvents), [allEvents]);

  // Today's key (for day view)
  const todayKey = toDateKey(TODAY_YEAR, TODAY_MONTH, TODAY_DAY);

  // Accepted service requests — the only ones the CHW can create sessions for
  const acceptedRequests = useMemo<ServiceRequestData[]>(() => {
    return (rawRequests ?? []).filter((r) => r.status === 'accepted');
  }, [rawRequests]);

  const handleOpenScheduleModal = useCallback(() => {
    setIsScheduleModalOpen(true);
  }, []);

  const handleCloseScheduleModal = useCallback(() => {
    setIsScheduleModalOpen(false);
  }, []);

  const handleScheduleSuccess = useCallback(() => {
    void refetch();
  }, [refetch]);

  if (isLoading) {
    return (
      <AppShell role="chw" activeKey="appointments" userBlock={{ initials: '...', name: '...', role: 'CHW' }}>
        <SafeAreaView style={styles.safe} edges={['top']}>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <Text style={styles.pageTitle}>Calendar</Text>
            <LoadingSkeleton variant="card" />
          </ScrollView>
        </SafeAreaView>
      </AppShell>
    );
  }

  if (error) {
    return (
      <AppShell role="chw" activeKey="appointments" userBlock={{ initials: '...', name: '...', role: 'CHW' }}>
        <SafeAreaView style={styles.safe} edges={['top']}>
          <ErrorState message="Failed to load calendar" onRetry={() => void refetch()} />
        </SafeAreaView>
      </AppShell>
    );
  }

  const handlePrevMonth = useCallback(() => {
    setCurrentDate((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
    setSelectedDay(null);
  }, []);

  const handleNextMonth = useCallback(() => {
    setCurrentDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
    setSelectedDay(null);
  }, []);

  const handlePrevWeek = useCallback(() => {
    setWeekAnchor((prev) => {
      const next = new Date(prev);
      next.setDate(prev.getDate() - 7);
      return next;
    });
  }, []);

  const handleNextWeek = useCallback(() => {
    setWeekAnchor((prev) => {
      const next = new Date(prev);
      next.setDate(prev.getDate() + 7);
      return next;
    });
  }, []);

  const handleDayPress = useCallback((day: number) => {
    setSelectedDay((prev) => (prev === day ? null : day));
  }, []);

  const handleSlotPress = useCallback((_date: Date, _hour: number) => {
    // Preserve scheduling/reschedule flow:
    // TODO(nav): navigate to CreateAppointment when the route is wired by parent.
    // For now this is a no-op to avoid referencing navigation that isn't in scope.
  }, []);

  const selectedDateKey = selectedDay !== null ? toDateKey(year, month, selectedDay) : null;
  const selectedEvents = selectedDateKey ? (eventsByDate.get(selectedDateKey) ?? []) : [];

  // ── View mode header title ─────────────────────────────────────────────────

  const navTitle = viewMode === 'month'
    ? `${MONTH_NAMES[month]} ${year}`
    : viewMode === 'week'
    ? `${MONTH_NAMES[weekDays[0].getMonth()]} ${weekDays[0].getDate()} – ${MONTH_NAMES[weekDays[6].getMonth()]} ${weekDays[6].getDate()}, ${weekDays[6].getFullYear()}`
    : `${MONTH_NAMES[TODAY_MONTH]} ${TODAY_DAY}, ${TODAY_YEAR}`;

  // ── Rendered content ───────────────────────────────────────────────────────

  /** View mode toggle chips — rendered in the PageHeader right slot alongside the CTA. */
  const headerRight = (
    <View style={styles.headerRightRow}>
      {/* Schedule Session CTA */}
      <TouchableOpacity
        style={styles.scheduleBtn}
        onPress={handleOpenScheduleModal}
        accessibilityRole="button"
        accessibilityLabel="Schedule a new session"
      >
        <Plus size={14} color="#FFFFFF" />
        <Text style={styles.scheduleBtnText}>Schedule Session</Text>
      </TouchableOpacity>

      {/* View mode toggle */}
      <View style={styles.viewToggle}>
        {(['day', 'week', 'month'] as CalendarViewMode[]).map((mode) => (
          <TouchableOpacity
            key={mode}
            style={[styles.toggleBtn, viewMode === mode && styles.toggleBtnActive]}
            onPress={() => setViewMode(mode)}
            accessibilityRole="button"
            accessibilityState={{ selected: viewMode === mode }}
          >
            <Text style={[styles.toggleBtnText, viewMode === mode && styles.toggleBtnTextActive]}>
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );

  const calendarContent = (
    <View style={styles.calendarOuter}>
      {/* Month nav bar (shared across all modes) */}
      <View style={styles.monthNav}>
        <TouchableOpacity
          style={styles.navButton}
          onPress={viewMode === 'week' ? handlePrevWeek : handlePrevMonth}
          accessibilityLabel={viewMode === 'week' ? 'Previous week' : 'Previous month'}
        >
          <ChevronLeft size={20} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.monthLabel}>{navTitle}</Text>
        <TouchableOpacity
          style={styles.navButton}
          onPress={viewMode === 'week' ? handleNextWeek : handleNextMonth}
          accessibilityLabel={viewMode === 'week' ? 'Next week' : 'Next month'}
        >
          <ChevronRight size={20} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      {/* Week view */}
      {viewMode === 'week' ? (
        <WeekViewGrid
          weekDays={weekDays}
          eventsByDate={eventsByDate}
          today={{ year: TODAY_YEAR, month: TODAY_MONTH, day: TODAY_DAY }}
          onSlotPress={handleSlotPress}
        />
      ) : viewMode === 'day' ? (
        // Day view: single-column hourly grid for today
        <View>
          <View style={styles.dayHeaderRow}>
            <Text style={styles.dayHeaderDate}>
              {DAY_LABELS_LONG[new Date(TODAY_YEAR, TODAY_MONTH, TODAY_DAY).getDay()]}
              {', '}
              {MONTH_NAMES[TODAY_MONTH]} {TODAY_DAY}
            </Text>
          </View>
          {WEEK_VIEW_HOURS.map((hour) => {
            const dayEvents = (eventsByDate.get(todayKey) ?? []).filter((e) => {
              const eventHour = parseInt(e.startTime.split(':')[0], 10);
              return eventHour === hour;
            });
            return (
              <View key={hour} style={styles.dayHourRow}>
                <Text style={styles.dayHourLabel}>{formatHourLabel(hour)}</Text>
                <View style={styles.dayHourCell}>
                  {dayEvents.map((event) => {
                    const barColor = eventColor(event);
                    return (
                      <View key={event.id} style={[styles.dayEventChip, { backgroundColor: barColor + '18', borderLeftColor: barColor }]}>
                        <Text style={[styles.dayEventText, { color: barColor }]} numberOfLines={1}>
                          {event.memberName ?? event.title}
                        </Text>
                        <Text style={[styles.dayEventMeta, { color: barColor }]}>
                          {formatTimeFull(event.startTime)}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            );
          })}
        </View>
      ) : (
        // Month view
        <>
          {/* Day-of-week headers */}
          <View style={styles.dayHeaderRow}>
            {DAY_LABELS.map((label) => (
              <View key={label} style={styles.dayHeaderCell}>
                <Text style={styles.dayHeaderText}>{label}</Text>
              </View>
            ))}
          </View>

          {/* Calendar grid */}
          <View style={styles.gridContainer}>
            {cells.map((day, index) => {
              if (day === null) {
                return (
                  <View
                    key={`empty-${index}`}
                    style={[styles.dayCell, styles.dayCellEmpty]}
                  />
                );
              }

              const key = toDateKey(year, month, day);
              const dayEvents = eventsByDate.get(key) ?? [];
              const memberCount = dayEvents.length;
              const isToday =
                year === TODAY_YEAR && month === TODAY_MONTH && day === TODAY_DAY;
              const isSelected = selectedDay === day;

              return (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.dayCell,
                    isSelected && styles.dayCellSelected,
                  ]}
                  onPress={() => handleDayPress(day)}
                  accessibilityRole="button"
                  accessibilityLabel={`${MONTH_NAMES[month]} ${day}${memberCount > 0 ? `, ${memberCount} member${memberCount !== 1 ? 's' : ''}` : ''}`}
                  accessibilityState={{ selected: isSelected }}
                >
                  {/* Day number */}
                  <View
                    style={[
                      styles.dayNumber,
                      isToday && styles.dayNumberToday,
                    ]}
                  >
                    <Text
                      style={[
                        styles.dayNumberText,
                        isToday && styles.dayNumberTextToday,
                        isSelected && !isToday && styles.dayNumberTextSelected,
                      ]}
                    >
                      {day}
                    </Text>
                  </View>

                  {/* Member-count badge — per Jemal's Calendar Figma feedback */}
                  {memberCount > 0 ? (
                    <View style={styles.memberCountBadge}>
                      <Text style={styles.memberCountText}>{memberCount}</Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      )}
    </View>
  );

  // Web: full-width single-column layout (no right rail)
  if (Platform.OS === 'web') {
    return (
      <AppShell role="chw" activeKey="appointments" userBlock={{ initials: 'C', name: 'CHW', role: 'CHW' }}>
        <View style={webStyles.root}>
          <PageHeader
            title="Calendar"
            subtitle="Your schedule and appointments"
            right={headerRight}
          />

          <Card style={webStyles.calendarCard}>
            {calendarContent}
          </Card>

          {/* Selected day detail panel (month view) */}
          {viewMode === 'month' && selectedDay !== null ? (
            <View style={styles.detailSection}>
              <Text style={styles.detailHeading}>
                {MONTH_NAMES[month]} {selectedDay}
              </Text>
              {selectedEvents.length === 0 ? (
                <View style={styles.emptyDay}>
                  <CalendarDays size={28} color={colors.border} />
                  <Text style={styles.emptyDayText}>No events on this day</Text>
                </View>
              ) : (
                selectedEvents.map((event) => (
                  <EventDetailCard key={event.id} event={event} />
                ))
              )}
            </View>
          ) : null}

          {/* Legend */}
          <Card style={webStyles.legendCard}>
            <SectionHeader title="Member Journey" marginBottom={spacing.md} />
            {(Object.keys(JOURNEY_COLORS) as JourneyStatus[]).map((key) => (
              <View key={key} style={styles.legendRow}>
                <View style={[styles.legendDot, { backgroundColor: JOURNEY_COLORS[key] }]} />
                <View style={styles.legendTextBlock}>
                  <Text style={styles.legendLabel}>{JOURNEY_LABELS[key]}</Text>
                  <Text style={styles.legendDesc}>{JOURNEY_DESCRIPTIONS[key]}</Text>
                </View>
              </View>
            ))}
          </Card>
        </View>

        {/* Schedule Session modal */}
        <ScheduleSessionModal
          visible={isScheduleModalOpen}
          onClose={handleCloseScheduleModal}
          onSuccess={handleScheduleSuccess}
          acceptedRequests={acceptedRequests}
          isLoadingRequests={isLoadingRequests}
        />
      </AppShell>
    );
  }

  // Native layout — full-width single-column + refresh control
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={refresh.control}
      >
        {/* Page header */}
        <View style={styles.nativeHeaderRow}>
          <Text style={styles.pageTitle}>Calendar</Text>
          {headerRight}
        </View>

        {/* Calendar card */}
        <View style={styles.calendarCard}>
          {calendarContent}
        </View>

        {/* Selected day detail panel */}
        {viewMode === 'month' && selectedDay !== null ? (
          <View style={styles.detailSection}>
            <Text style={styles.detailHeading}>
              {MONTH_NAMES[month]} {selectedDay}
            </Text>
            {selectedEvents.length === 0 ? (
              <View style={styles.emptyDay}>
                <CalendarDays size={28} color={colors.border} />
                <Text style={styles.emptyDayText}>No events on this day</Text>
              </View>
            ) : (
              selectedEvents.map((event) => (
                <EventDetailCard key={event.id} event={event} />
              ))
            )}
          </View>
        ) : null}

        {/* Legend */}
        <View style={styles.legendCard}>
          <Text style={styles.legendTitle}>Member Journey</Text>
          {(Object.keys(JOURNEY_COLORS) as JourneyStatus[]).map((key) => (
            <View key={key} style={styles.legendRow}>
              <View
                style={[styles.legendDot, { backgroundColor: JOURNEY_COLORS[key] }]}
              />
              <View style={styles.legendTextBlock}>
                <Text style={styles.legendLabel}>{JOURNEY_LABELS[key]}</Text>
                <Text style={styles.legendDesc}>{JOURNEY_DESCRIPTIONS[key]}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* Schedule Session modal */}
      <ScheduleSessionModal
        visible={isScheduleModalOpen}
        onClose={handleCloseScheduleModal}
        onSuccess={handleScheduleSuccess}
        acceptedRequests={acceptedRequests}
        isLoadingRequests={isLoadingRequests}
      />
    </SafeAreaView>
  );
}

// ─── Web styles ───────────────────────────────────────────────────────────────

const webStyles = StyleSheet.create({
  root: {
    flex: 1,
    padding: 0,
  },
  calendarCard: {
    marginBottom: spacing.xxl,
    overflow: 'hidden',
  },
  legendCard: {
    padding: spacing.xl,
    marginBottom: spacing.xxl,
  },
});

// ─── Styles ───────────────────────────────────────────────────────────────────

const CELL_ASPECT = 52;

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: tokens.pageBg,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: spacing.xl,
    paddingBottom: 48,
  },
  nativeHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xl,
    gap: spacing.md,
    flexWrap: 'wrap',
  },
  pageTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: tokens.textPrimary,
  },
  headerRightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  scheduleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: tokens.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
  },
  scheduleBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#FFFFFF',
  },
  viewToggle: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 2,
  },
  toggleBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
  },
  toggleBtnActive: {
    backgroundColor: tokens.primary,
  },
  toggleBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#6B7A6B',
  },
  toggleBtnTextActive: {
    color: '#FFFFFF',
  },
  calendarOuter: {
    overflow: 'hidden',
  },
  calendarCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    overflow: 'hidden',
    marginBottom: spacing.xl,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  monthNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    backgroundColor: tokens.primary,
    borderBottomWidth: 1,
    borderBottomColor: tokens.primary,
  },
  navButton: {
    padding: 6,
    borderRadius: radius.sm + 2,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  monthLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 15,
    lineHeight: 22,
    color: '#FFFFFF',
  },
  dayHeaderRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
  },
  dayHeaderCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
  },
  dayHeaderText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#6B7A6B',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  dayHeaderDate: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 15,
    color: tokens.textPrimary,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  dayHourRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    minHeight: 52,
    borderBottomWidth: 1,
    borderBottomColor: '#F0EDE9',
  },
  dayHourLabel: {
    width: 64,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: '#9CA3AF',
    paddingTop: 8,
    paddingRight: 8,
    textAlign: 'right',
  },
  dayHourCell: {
    flex: 1,
    padding: 4,
    gap: 3,
  },
  dayEventChip: {
    borderLeftWidth: 2,
    borderRadius: 4,
    padding: 6,
    gap: 1,
  },
  dayEventText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
  },
  dayEventMeta: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
  },
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCell: {
    width: '14.2857%',
    minHeight: CELL_ASPECT,
    padding: 4,
    borderRightWidth: 1,
    borderRightColor: '#DDD6CC',
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
    alignItems: 'flex-start',
  },
  dayCellEmpty: {
    backgroundColor: tokens.pageBg,
  },
  dayCellSelected: {
    backgroundColor: tokens.primary + '15',
  },
  dayNumber: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  dayNumberToday: {
    borderColor: tokens.primary,
    backgroundColor: 'transparent',
  },
  dayNumberText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.textPrimary,
    lineHeight: 14,
  },
  dayNumberTextToday: {
    color: tokens.primary,
    fontFamily: 'PlusJakartaSans_600SemiBold',
  },
  dayNumberTextSelected: {
    color: tokens.emerald700,
    fontFamily: 'PlusJakartaSans_600SemiBold',
  },
  memberCountBadge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    backgroundColor: tokens.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  memberCountText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 11,
    lineHeight: 14,
    color: '#FFFFFF',
  },
  detailSection: {
    marginBottom: spacing.xl,
  },
  detailHeading: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
  },
  emptyDay: {
    backgroundColor: '#FFFFFF',
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 28,
    alignItems: 'center',
    gap: 8,
  },
  emptyDayText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: tokens.textSecondary,
  },
  legendCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  legendTitle: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 6,
  },
  legendDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    flexShrink: 0,
    marginTop: 2,
  },
  legendTextBlock: {
    flex: 1,
    gap: 1,
  },
  legendLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: tokens.textPrimary,
  },
  legendDesc: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: tokens.textSecondary,
    lineHeight: 16,
  },
});

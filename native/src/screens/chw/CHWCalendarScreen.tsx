/**
 * CHWCalendarScreen — Full-width calendar grid with Schedule Session modal.
 *
 * Features:
 *  - Day/Week/Month toggle in header (Week default on web)
 *  - Week view: 7 columns × hourly rows 8 AM–5 PM, today highlighted
 *  - Month view: 7-column grid with session-count badges
 *  - Day view: single-column hourly grid for today
 *  - "+ Schedule Session" CTA — opens member-based scheduling modal
 *  - Session card tap → Session Details modal with "Open Member Profile" action
 *  - No right-side rail — calendar occupies full width
 */

import React, {
  useState,
  useMemo,
  useCallback,
  useEffect,
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
  Phone,
  Video,
  Plus,
  X,
  CheckCircle,
  AlertCircle,
  User,
} from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';

import { colors as tokens, numerals, spacing, radius } from '../../theme/tokens';
import { colors } from '../../theme/colors';
import {
  AppShell,
  PageHeader,
  Card,
} from '../../components/ui';
import {
  useSessions,
  useChwMembers,
  useScheduleSession,
  useConfirmSession,
  useDeclineSession,
  useStartSession,
  useCancelSession,
  type SessionData,
  type MembersRosterItem,
} from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import {
  VERTICAL_PICKER_OPTIONS,
  VERTICAL_LABEL,
  VERTICAL_COLOR,
  type Vertical,
} from '../../lib/verticals';
import {
  isHourAvailable,
  type AvailabilityWindows,
} from '../../utils/availabilityShading';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { showAlert } from '../../utils/showAlert';

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_NAMES_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const DAY_LABELS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_LABELS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Hours displayed in the week/day view grid (8 AM – 5 PM inclusive). */
const WEEK_VIEW_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

/** Height in px for a single 1-hour slot in the week grid. Taller so 30-minute
 *  session blocks (SLOT_HEIGHT/2 = 48px) are easy to read; a lighter divider
 *  line marks the :30 half-hour increment. */
const SLOT_HEIGHT = 96;

type CalendarViewMode = 'day' | 'week' | 'month';

type SessionMode = 'in_person' | 'virtual' | 'phone';

// ─── Status badge helpers ─────────────────────────────────────────────────────

export type SessionBadgeStatus = 'Confirmed' | 'Pending' | 'Completed' | 'Cancelled' | 'Missed';

/**
 * Derives a display status badge from a SessionData row, reflecting the
 * session's REAL status — no inferred/hardcoded "Missed" for a session that
 * was merely never started (see point 4 below).
 *
 * Priority:
 *  1. completed → "Completed"
 *  2. no_show (Epic O2 — CHW began the session but the member never
 *     attended, PATCH /sessions/{id}/no-show) → "Missed"
 *  3. cancelled/cancelled_no_consent (CHW or member cancelled/removed it) → "Cancelled"
 *  4. schedulingStatus 'pending' (awaiting Confirm/Decline) → "Pending"
 *  5. default (scheduled — upcoming OR past-but-never-started) → "Confirmed"
 *
 * A past session that stayed `scheduled` (the CHW never began it) is
 * intentionally still "Confirmed" here rather than "Missed" — the "Missed"
 * tag is reserved for the distinct, explicit no_show signal (Epic O2) that
 * the CHW actually began the session and the member failed to attend.
 * Silently relabeling every past-and-not-started session as "Missed" would
 * be misleading (e.g. documentation submitted late, or the row hasn't
 * refreshed yet).
 *
 * `no_show` is DISTINCT from `cancelled` in the calendar grid too: a
 * cancelled session is excluded entirely (see `groupSessionsByDate`'s N1
 * behavior), while a no_show session stays visible, tagged "Missed", for
 * record-keeping.
 */
export function deriveBadgeStatus(session: SessionData, now: Date): SessionBadgeStatus {
  if (session.status === 'completed') return 'Completed';
  if (session.status === 'no_show') return 'Missed';
  if (session.status === 'cancelled' || session.status === 'cancelled_no_consent') return 'Cancelled';
  if (session.schedulingStatus === 'pending') return 'Pending';
  return 'Confirmed';
}

const BADGE_COLORS: Record<SessionBadgeStatus, { bg: string; text: string; border: string }> = {
  Confirmed: { bg: '#DCFCE7', text: '#15803D', border: '#BBF7D0' },
  Missed: { bg: '#FEF3C7', text: '#B45309', border: '#FDE68A' },
  Pending: { bg: '#FEF9C3', text: '#A16207', border: '#FDE68A' },
  Completed: { bg: '#F3F4F6', text: '#374151', border: '#E5E7EB' },
  Cancelled: { bg: '#FEE2E2', text: '#B91C1C', border: '#FECACA' },
};

// ─── Icon helpers ─────────────────────────────────────────────────────────────

/** Session mode → lucide icon component. */
function SessionModeIcon({
  mode,
  size = 12,
  color: colorProp,
}: {
  mode?: string;
  size?: number;
  color?: string;
}): React.JSX.Element {
  const c = colorProp ?? colors.mutedForeground;
  if (mode === 'phone') return <Phone size={size} color={c} />;
  if (mode === 'virtual') return <Video size={size} color={c} />;
  return <MapPin size={size} color={c} />;
}

/** Human-readable label for a session mode. */
function sessionModeLabel(mode?: string): string {
  if (mode === 'phone') return 'Phone Session';
  if (mode === 'virtual') return 'Video Session';
  if (mode === 'in_person') return 'In-Person Session';
  return 'Session';
}

// ─── Grid math helpers ────────────────────────────────────────────────────────

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

/** Returns the Mon–Sun 7-day Date[] for the ISO week containing the given date. */
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

/**
 * Formats an hour integer (24h) → "8 AM" / "12 PM" etc.
 */
function formatHourLabel(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

/**
 * Formats an ISO datetime string to "10:00 AM" local time.
 */
function formatTimeAMPM(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h >= 12 ? 'PM' : 'AM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * Formats two ISO strings to a range label: "10:00 AM – 11:00 AM".
 * If end is null/undefined, returns just the start time.
 */
function formatTimeRange(startIso: string, endIso?: string | null): string {
  const start = formatTimeAMPM(startIso);
  if (!endIso) return start;
  const end = formatTimeAMPM(endIso);
  return `${start} – ${end}`;
}

/**
 * Returns the fractional top offset within the grid for a given ISO start time
 * (relative to WEEK_VIEW_HOURS[0] = 8 AM).
 */
function computeTopOffset(scheduledAt: string): number {
  const d = new Date(scheduledAt);
  const hour = d.getHours();
  const minute = d.getMinutes();
  const offset = (hour - WEEK_VIEW_HOURS[0]) + minute / 60;
  return Math.max(0, offset) * SLOT_HEIGHT;
}

/**
 * Returns the block height for a session in the grid.
 * Uses scheduledEndAt when available; defaults to 1 hr.
 */
function computeBlockHeight(scheduledAt: string, scheduledEndAt?: string | null): number {
  if (!scheduledEndAt) return SLOT_HEIGHT;
  const start = new Date(scheduledAt).getTime();
  const end = new Date(scheduledEndAt).getTime();
  const durationHours = (end - start) / (1000 * 60 * 60);
  return Math.max(SLOT_HEIGHT * 0.5, durationHours * SLOT_HEIGHT);
}

/**
 * Formats an ISO datetime string to a short date label: "Fri, Jun 20, 2026"
 */
function formatDateLabel(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Formats an ISO datetime string to "MM/DD/YYYY" local time — the exact
 * format ScheduleSessionModal's Date TextInput expects (round-trips through
 * its own parseDateTime). Used to prefill the "Propose New Time" flow from
 * an existing session's scheduledAt/scheduledEndAt.
 */
function formatDateInputValue(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/**
 * Converts a local Date to a YYYY-MM-DDTHH:mm string for datetime-local inputs.
 */
function toISODateTimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Groups SessionData[] by their local calendar date key (YYYY-MM-DD).
 *
 * Removed/cancelled sessions (`cancelled` and `cancelled_no_consent`) are
 * excluded entirely — once a CHW confirms "Yes, Remove" on a scheduled
 * session, it must vanish from the calendar grid (week/day cards AND the
 * month-view day-cell count both read from this map), not linger as a
 * dangling entry. This is distinct from a past session that stayed
 * `scheduled` (never started) — that one is NOT cancelled and still renders.
 *
 * `no_show` (Epic O2 — "Missed Session") is deliberately NOT in this
 * exclusion list: a no-show is record-keeping, not a removal — the CHW
 * showed up and began the session, so it stays visible on the calendar
 * tagged "Missed" (see `deriveBadgeStatus`) rather than vanishing like a
 * cancelled appointment.
 */
function groupSessionsByDate(sessions: SessionData[]): Map<string, SessionData[]> {
  const map = new Map<string, SessionData[]>();
  for (const session of sessions) {
    if (session.status === 'cancelled' || session.status === 'cancelled_no_consent') continue;
    const d = new Date(session.scheduledAt);
    const key = toDateKey(d.getFullYear(), d.getMonth(), d.getDate());
    const bucket = map.get(key) ?? [];
    map.set(key, [...bucket, session]);
  }
  return map;
}

// ─── Session card (week/day grid) ─────────────────────────────────────────────

interface SessionCardProps {
  session: SessionData;
  now: Date;
  onPress: (session: SessionData) => void;
}

/** A positioned absolute card rendered inside a weekly time grid column. */
function SessionCard({ session, now, onPress }: SessionCardProps): React.JSX.Element {
  const badge = deriveBadgeStatus(session, now);
  const badgeStyle = BADGE_COLORS[badge];
  const topOffset = computeTopOffset(session.scheduledAt);
  const blockHeight = computeBlockHeight(session.scheduledAt, session.scheduledEndAt);

  return (
    <TouchableOpacity
      style={[
        sessionCardStyles.card,
        { top: topOffset, height: blockHeight },
      ]}
      onPress={() => onPress(session)}
      accessibilityRole="button"
      accessibilityLabel={`Session with ${session.memberName ?? 'member'} at ${formatTimeAMPM(session.scheduledAt)}`}
    >
      <View style={sessionCardStyles.leftBorder} />
      <View style={sessionCardStyles.body}>
        <Text style={[sessionCardStyles.time, numerals.tabular]} numberOfLines={1}>
          {formatTimeAMPM(session.scheduledAt)}
        </Text>
        <Text style={sessionCardStyles.memberName} numberOfLines={1}>
          {session.memberName ?? 'Member'}
        </Text>
        <View style={sessionCardStyles.typeRow}>
          <SessionModeIcon mode={session.mode} size={10} color={tokens.emerald700} />
          <Text style={sessionCardStyles.typeLabel} numberOfLines={1}>
            {sessionModeLabel(session.mode)}
          </Text>
        </View>
        {blockHeight >= 50 ? (
          <View style={[sessionCardStyles.badge, { backgroundColor: badgeStyle.bg, borderColor: badgeStyle.border }]}>
            <Text style={[sessionCardStyles.badgeText, { color: badgeStyle.text }]}>{badge}</Text>
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const sessionCardStyles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: 2,
    right: 2,
    backgroundColor: '#F0FDF4',
    borderRadius: 6,
    flexDirection: 'row',
    overflow: 'hidden',
    zIndex: 1,
  },
  leftBorder: {
    width: 3,
    backgroundColor: tokens.primary,
    flexShrink: 0,
  },
  body: {
    flex: 1,
    padding: 4,
    gap: 1,
  },
  time: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 9,
    color: tokens.emerald700,
  },
  memberName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 10,
    color: '#1E3320',
    lineHeight: 13,
  },
  typeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  typeLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 9,
    color: tokens.emerald700,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
    marginTop: 2,
  },
  badgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 8,
  },
});

// ─── WeekViewGrid ─────────────────────────────────────────────────────────────

interface WeekViewGridProps {
  weekDays: Date[];
  sessionsByDate: Map<string, SessionData[]>;
  today: { year: number; month: number; day: number };
  now: Date;
  onSessionPress: (session: SessionData) => void;
  /** The CHW's own availability — cells outside these hours/days are greyed. */
  availabilityWindows?: AvailabilityWindows;
}

/**
 * Mon–Sun weekly grid with hourly rows (8 AM – 5 PM).
 * Today's date number sits in a green filled circle.
 * Session cards are positioned absolutely within each column.
 */
function WeekViewGrid({
  weekDays,
  sessionsByDate,
  today,
  now,
  onSessionPress,
  availabilityWindows,
}: WeekViewGridProps): React.JSX.Element {
  const totalGridHeight = WEEK_VIEW_HOURS.length * SLOT_HEIGHT;

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      {/* Day header row */}
      <View style={weekStyles.headerRow}>
        <View style={weekStyles.timeGutter} />
        {weekDays.map((date) => {
          const isToday =
            date.getFullYear() === today.year &&
            date.getMonth() === today.month &&
            date.getDate() === today.day;
          return (
            <View key={dateToKey(date)} style={weekStyles.dayHeaderCell}>
              <Text style={[weekStyles.dayLabel, isToday && weekStyles.dayLabelToday]}>
                {DAY_LABELS_SHORT[weekDays.indexOf(date)]}
              </Text>
              <View style={[weekStyles.dateCircle, isToday && weekStyles.dateCircleToday]}>
                <Text style={[weekStyles.dateNumber, isToday && weekStyles.dateNumberToday]}>
                  {date.getDate()}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      {/* Grid body: time gutter + column for each day */}
      <View style={weekStyles.gridBody}>
        {/* Time gutter */}
        <View style={weekStyles.timeGutter}>
          {WEEK_VIEW_HOURS.map((hour) => (
            <View key={hour} style={{ height: SLOT_HEIGHT, justifyContent: 'flex-start', paddingTop: 4 }}>
              <Text style={[weekStyles.timeLabel, numerals.tabular]}>{formatHourLabel(hour)}</Text>
            </View>
          ))}
        </View>

        {/* Day columns */}
        {weekDays.map((date) => {
          const key = dateToKey(date);
          const daySessions = sessionsByDate.get(key) ?? [];
          const isToday =
            date.getFullYear() === today.year &&
            date.getMonth() === today.month &&
            date.getDate() === today.day;

          return (
            <View key={key} style={[weekStyles.dayColumn, isToday && weekStyles.dayColumnToday]}>
              {/* Hour grid lines with a lighter :30 half-hour divider. */}
              {WEEK_VIEW_HOURS.map((hour) => {
                const unavailable =
                  availabilityWindows !== undefined &&
                  !isHourAvailable(availabilityWindows, date, hour);
                return (
                  <View
                    key={hour}
                    style={[weekStyles.hourLine, unavailable && weekStyles.hourUnavailable]}
                  >
                    <View style={weekStyles.halfHourLine} />
                  </View>
                );
              })}
              {/* Absolute-position session cards */}
              <View style={[weekStyles.cardsLayer, { height: totalGridHeight }]}>
                {daySessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    now={now}
                    onPress={onSessionPress}
                  />
                ))}
              </View>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

const weekStyles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
    paddingVertical: 10,
  },
  timeGutter: {
    width: 56,
    paddingRight: 8,
    alignItems: 'flex-end',
  },
  dayHeaderCell: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  dayLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  dayLabelToday: {
    color: tokens.primary,
  },
  dateCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateCircleToday: {
    backgroundColor: tokens.primary,
  },
  dateNumber: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#1E3320',
  },
  dateNumberToday: {
    color: '#FFFFFF',
  },
  gridBody: {
    flexDirection: 'row',
  },
  dayColumn: {
    flex: 1,
    borderLeftWidth: 1,
    borderLeftColor: '#F3F4F6',
    position: 'relative',
  },
  dayColumnToday: {
    backgroundColor: tokens.primary + '04',
  },
  hourLine: {
    height: SLOT_HEIGHT,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  // Lighter divider at the :30 half-hour mark inside each hour cell.
  halfHourLine: {
    position: 'absolute',
    top: SLOT_HEIGHT / 2,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: '#F9FAFB',
  },
  // Outside the CHW's working hours.
  hourUnavailable: {
    backgroundColor: '#F3F4F6',
  },
  cardsLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  timeLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: '#9CA3AF',
    textAlign: 'right',
  },
});

// ─── Day view grid ────────────────────────────────────────────────────────────

interface DayViewGridProps {
  date: Date;
  sessions: SessionData[];
  now: Date;
  onSessionPress: (session: SessionData) => void;
  /** The CHW's own availability — cells outside these hours are greyed. */
  availabilityWindows?: AvailabilityWindows;
}

function DayViewGrid({
  date,
  sessions,
  now,
  onSessionPress,
  availabilityWindows,
}: DayViewGridProps): React.JSX.Element {
  const totalGridHeight = WEEK_VIEW_HOURS.length * SLOT_HEIGHT;

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <View style={dayViewStyles.dateHeader}>
        <Text style={dayViewStyles.dateText}>
          {DAY_LABELS_LONG[date.getDay()]}, {MONTH_NAMES[date.getMonth()]} {date.getDate()}, {date.getFullYear()}
        </Text>
      </View>
      <View style={dayViewStyles.grid}>
        <View style={weekStyles.timeGutter}>
          {WEEK_VIEW_HOURS.map((hour) => (
            <View key={hour} style={{ height: SLOT_HEIGHT, justifyContent: 'flex-start', paddingTop: 4 }}>
              <Text style={[weekStyles.timeLabel, numerals.tabular]}>{formatHourLabel(hour)}</Text>
            </View>
          ))}
        </View>
        <View style={dayViewStyles.column}>
          {WEEK_VIEW_HOURS.map((hour) => {
            const unavailable =
              availabilityWindows !== undefined &&
              !isHourAvailable(availabilityWindows, date, hour);
            return (
              <View
                key={hour}
                style={[weekStyles.hourLine, unavailable && weekStyles.hourUnavailable]}
              >
                <View style={weekStyles.halfHourLine} />
              </View>
            );
          })}
          <View style={[weekStyles.cardsLayer, { height: totalGridHeight }]}>
            {sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                now={now}
                onPress={onSessionPress}
              />
            ))}
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const dayViewStyles = StyleSheet.create({
  dateHeader: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  dateText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#1E3320',
  },
  grid: {
    flexDirection: 'row',
  },
  column: {
    flex: 1,
    borderLeftWidth: 1,
    borderLeftColor: '#F3F4F6',
    position: 'relative',
  },
});

// ─── Month view grid ──────────────────────────────────────────────────────────

interface MonthViewGridProps {
  year: number;
  month: number;
  cells: (number | null)[];
  sessionsByDate: Map<string, SessionData[]>;
  today: { year: number; month: number; day: number };
  selectedDay: number | null;
  onDayPress: (day: number) => void;
}

function MonthViewGrid({
  year,
  month,
  cells,
  sessionsByDate,
  today,
  selectedDay,
  onDayPress,
}: MonthViewGridProps): React.JSX.Element {
  const DAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <View>
      {/* Day-of-week headers */}
      <View style={monthStyles.headerRow}>
        {DAY_HEADERS.map((label) => (
          <View key={label} style={monthStyles.headerCell}>
            <Text style={monthStyles.headerText}>{label}</Text>
          </View>
        ))}
      </View>

      {/* Calendar grid */}
      <View style={monthStyles.grid}>
        {cells.map((day, index) => {
          if (day === null) {
            return <View key={`empty-${index}`} style={monthStyles.emptyCell} />;
          }

          const key = toDateKey(year, month, day);
          const count = (sessionsByDate.get(key) ?? []).length;
          const isToday = year === today.year && month === today.month && day === today.day;
          const isSelected = selectedDay === day;

          return (
            <TouchableOpacity
              key={key}
              style={[monthStyles.dayCell, isSelected && monthStyles.dayCellSelected]}
              onPress={() => onDayPress(day)}
              accessibilityRole="button"
              accessibilityLabel={`${MONTH_NAMES[month]} ${day}${count > 0 ? `, ${count} session${count !== 1 ? 's' : ''}` : ''}`}
              accessibilityState={{ selected: isSelected }}
            >
              <View style={[monthStyles.dayNumber, isToday && monthStyles.dayNumberToday]}>
                <Text style={[monthStyles.dayText, isToday && monthStyles.dayTextToday]}>
                  {day}
                </Text>
              </View>
              {count > 0 ? (
                <View style={monthStyles.countBadge}>
                  <Text style={monthStyles.countText}>{count}</Text>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// Month-view day-cell minimum height. Sized to give the grid vertical
// breathing room on the desktop CHW calendar (was 52 — too cramped, leaving a
// short grid stranded in a tall viewport). Width stays percentage-based (1/7),
// so this only affects row height.
const CELL_SIZE = 108;

const monthStyles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  headerCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
  },
  headerText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  emptyCell: {
    width: '14.2857%',
    minHeight: CELL_SIZE,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#F3F4F6',
    backgroundColor: '#FAFAFA',
  },
  dayCell: {
    width: '14.2857%',
    minHeight: CELL_SIZE,
    padding: 4,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#F3F4F6',
    alignItems: 'flex-start',
  },
  dayCellSelected: {
    backgroundColor: tokens.primary + '10',
  },
  dayNumber: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayNumberToday: {
    backgroundColor: tokens.primary,
  },
  dayText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#1E3320',
  },
  dayTextToday: {
    color: '#FFFFFF',
    fontFamily: 'DMSans_700Bold',
  },
  countBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: tokens.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 3,
  },
  countText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 10,
    color: '#FFFFFF',
  },
});

// ─── Session Details Modal ────────────────────────────────────────────────────

interface SessionDetailsModalProps {
  session: SessionData | null;
  now: Date;
  visible: boolean;
  onClose: () => void;
  onOpenProfile: (memberId: string) => void;
  /** Navigates to Messages for this member — used by "Begin Session" once the
   *  session is confirmed started. */
  onNavigateToMessages: (memberId: string) => void;
  /** Opens ScheduleSessionModal in "Propose New Time" mode for this session —
   *  identical wiring to PendingRequestsList's onProposeNewTime. */
  onProposeNewTime: (session: SessionData) => void;
}

function SessionDetailsModal({
  session,
  now,
  visible,
  onClose,
  onOpenProfile,
  onNavigateToMessages,
  onProposeNewTime,
}: SessionDetailsModalProps): React.JSX.Element {
  // Hooks must run unconditionally, before the early return below.
  const confirmSession = useConfirmSession();
  const declineSession = useDeclineSession();
  const startSession = useStartSession();
  const cancelSession = useCancelSession();
  const actionPending = confirmSession.isPending || declineSession.isPending;
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);

  if (!session) return <View />;

  const badge = deriveBadgeStatus(session, now);
  const badgeStyle = BADGE_COLORS[badge];
  const isPending = badge === 'Pending';
  // QA2 A2 #17 — a pending session's action row now branches on WHO proposed
  // it, mirroring the initiator-inversion rule the backend already enforces
  // on confirm/decline:
  //   - proposedBy === 'member' (or null/legacy — same "unknown initiator,
  //     preserve today's CHW behavior" default used elsewhere in this file)
  //     → this is a MEMBER's request awaiting the CHW's decision, so it keeps
  //     the existing Confirm/Decline row.
  //   - proposedBy === 'chw' → this is the CHW's OWN proposal awaiting the
  //     MEMBER's decision. Confirm/Decline on your own proposal is invalid
  //     self-approval (the backend 409s a CHW-confirm on proposed_by='chw'
  //     sessions — see routers/sessions.py's initiator-inversion rule), so
  //     instead this shows Remove (cancel the stale proposal outright) +
  //     Propose New Time (counter-offer yet another slot).
  const isPendingAwaitingChwDecision = isPending && session.proposedBy !== 'chw';
  const isPendingChwProposed = isPending && session.proposedBy === 'chw';
  // An upcoming session the CHW has already confirmed (not a member request
  // still awaiting approval — that keeps its existing Confirm/Decline row +
  // Open Member Profile below, unchanged) gets the Begin Session / Propose
  // New Time action row instead of the plain Open Member Profile button.
  // Past-scheduled/completed/cancelled sessions are unaffected. QA2 A2 #17 —
  // Remove was DELETED from this row (product decision): a confirmed
  // upcoming session's only actions are Begin Session + Propose New Time.
  const isConfirmedUpcoming =
    session.status === 'scheduled' && new Date(session.scheduledAt) >= now && !isPending;

  return (
      <>
        <Modal
          visible={visible}
          transparent
          animationType="fade"
          onRequestClose={onClose}
          accessibilityViewIsModal
        >
          <View style={detailModalStyles.overlay}>
            <View style={detailModalStyles.sheet}>
              {/* Header */}
              <View style={detailModalStyles.header}>
                <View style={detailModalStyles.headerLeft}>
                  <Text style={detailModalStyles.headerTitle}>Session Details</Text>
                </View>
                <TouchableOpacity
                  style={detailModalStyles.closeBtn}
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel="Close session details"
                >
                  <X size={18} color={tokens.textSecondary} />
                </TouchableOpacity>
              </View>

              <ScrollView
                style={detailModalStyles.body}
                contentContainerStyle={detailModalStyles.bodyContent}
                showsVerticalScrollIndicator={false}
              >
                {/* Member name */}
                <View style={detailModalStyles.memberRow}>
                  <View style={detailModalStyles.avatarCircle}>
                    <User size={20} color={tokens.primary} />
                  </View>
                  <Text style={detailModalStyles.memberName}>
                    {session.memberName ?? 'Member'}
                  </Text>
                </View>

                {/* Status badge */}
                <View style={[detailModalStyles.statusBadge, { backgroundColor: badgeStyle.bg, borderColor: badgeStyle.border }]}>
                  {badge === 'Confirmed' ? (
                    <CheckCircle size={12} color={badgeStyle.text} />
                  ) : badge === 'Cancelled' ? (
                    <AlertCircle size={12} color={badgeStyle.text} />
                  ) : null}
                  <Text style={[detailModalStyles.statusText, { color: badgeStyle.text }]}>{badge}</Text>
                </View>

                {/* Details rows */}
                <View style={detailModalStyles.detailsCard}>
                  <View style={detailModalStyles.detailRow}>
                    <CalendarDays size={14} color={tokens.textSecondary} />
                    <View style={detailModalStyles.detailContent}>
                      <Text style={detailModalStyles.detailLabel}>Date</Text>
                      <Text style={detailModalStyles.detailValue}>
                        {formatDateLabel(session.scheduledAt)}
                      </Text>
                    </View>
                  </View>

                  <View style={detailModalStyles.divider} />

                  <View style={detailModalStyles.detailRow}>
                    <Clock size={14} color={tokens.textSecondary} />
                    <View style={detailModalStyles.detailContent}>
                      <Text style={detailModalStyles.detailLabel}>Time</Text>
                      <Text style={detailModalStyles.detailValue}>
                        {formatTimeRange(session.scheduledAt, session.scheduledEndAt)}
                      </Text>
                    </View>
                  </View>

                  <View style={detailModalStyles.divider} />

                  <View style={detailModalStyles.detailRow}>
                    <SessionModeIcon mode={session.mode} size={14} color={tokens.textSecondary} />
                    <View style={detailModalStyles.detailContent}>
                      <Text style={detailModalStyles.detailLabel}>Session Type</Text>
                      <Text style={detailModalStyles.detailValue}>
                        {sessionModeLabel(session.mode)}
                      </Text>
                    </View>
                  </View>

                  {session.resourceNeeds && session.resourceNeeds.length > 0 ? (
                    <>
                      <View style={detailModalStyles.divider} />
                      <View style={detailModalStyles.detailRow}>
                        <View style={{ width: 14, alignItems: 'center' }}>
                          <Text style={{ fontSize: 14 }}>🏷️</Text>
                        </View>
                        <View style={detailModalStyles.detailContent}>
                          <Text style={detailModalStyles.detailLabel}>Resource Needs</Text>
                          <View
                            style={detailModalStyles.resourceNeedsRow}
                            accessibilityLabel="Resource needs"
                          >
                            {session.resourceNeeds.map((v) => (
                              <View
                                key={v}
                                style={[
                                  detailModalStyles.resourceNeedChip,
                                  {
                                    backgroundColor: `${VERTICAL_COLOR[v as Vertical] ?? tokens.textSecondary}1A`,
                                    borderColor: VERTICAL_COLOR[v as Vertical] ?? tokens.textSecondary,
                                  },
                                ]}
                              >
                                <Text
                                  style={[
                                    detailModalStyles.resourceNeedChipText,
                                    { color: VERTICAL_COLOR[v as Vertical] ?? tokens.textSecondary },
                                  ]}
                                >
                                  {VERTICAL_LABEL[v as Vertical] ?? v}
                                </Text>
                              </View>
                            ))}
                          </View>
                        </View>
                      </View>
                    </>
                  ) : null}
                </View>
              </ScrollView>

              {/* Footer */}
              <View style={detailModalStyles.footer}>
                {/* Confirm / Decline — only for a pending session awaiting THIS
                    CHW's decision (proposedBy 'member' or null/legacy). A
                    session the CHW itself proposed (proposedBy 'chw') is
                    awaiting the MEMBER's decision instead — see the Remove +
                    Propose New Time block below (QA2 A2 #17). */}
                {isPendingAwaitingChwDecision && (
                  <View style={detailModalStyles.confirmRow}>
                    <TouchableOpacity
                      style={[detailModalStyles.declineBtn, actionPending && { opacity: 0.6 }]}
                      disabled={actionPending}
                      onPress={async () => {
                        try {
                          await declineSession.mutateAsync(session.id);
                          onClose();
                        } catch {
                          // error surfaced by the hook's onError alert
                        }
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Decline session request"
                    >
                      <Text style={detailModalStyles.declineText}>Decline</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[detailModalStyles.confirmBtn, actionPending && { opacity: 0.6 }]}
                      disabled={actionPending}
                      onPress={async () => {
                        try {
                          await confirmSession.mutateAsync(session.id);
                          onClose();
                        } catch {
                          // error surfaced by the hook's onError alert
                        }
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Confirm session request"
                    >
                      <CheckCircle size={14} color="#FFFFFF" />
                      <Text style={detailModalStyles.confirmText}>
                        {confirmSession.isPending ? 'Confirming…' : 'Confirm'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* Remove / Propose New Time — a pending session the CHW itself
                    proposed. No Confirm/Decline here: confirming your own
                    proposal is invalid self-approval (backend 409s it), and
                    "declining" your own proposal is really a removal, so this
                    surfaces the same Remove confirm-dialog + Propose New Time
                    pairing as a confirmed upcoming session (QA2 A2 #17). */}
                {isPendingChwProposed && (
                  <View style={detailModalStyles.secondaryRow}>
                    <TouchableOpacity
                      style={detailModalStyles.removeBtn}
                      onPress={() => setRemoveConfirmOpen(true)}
                      accessibilityRole="button"
                      accessibilityLabel="Remove session"
                    >
                      <Text style={detailModalStyles.removeBtnText}>Remove</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={detailModalStyles.proposeBtn}
                      onPress={() => {
                        onClose();
                        onProposeNewTime(session);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Propose a new time"
                    >
                      <Text style={detailModalStyles.proposeBtnText}>Propose New Time</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {isConfirmedUpcoming ? (
                  // Upcoming, CHW-confirmed session — Begin/Propose replace the
                  // plain Open Member Profile button below. QA2 A2 #17: Remove
                  // was DELETED from this row (product decision) — a confirmed
                  // session's only actions are Begin Session + Propose New Time.
                  <View style={detailModalStyles.scheduledActions}>
                    <TouchableOpacity
                      style={[detailModalStyles.beginBtn, startSession.isPending && { opacity: 0.6 }]}
                      disabled={startSession.isPending}
                      onPress={async () => {
                        try {
                          await startSession.mutateAsync(session.id);
                        } catch {
                          // useStartSession intentionally does not alert (its other
                          // callers own specialized 409 handling) — surface a
                          // generic message here instead.
                          showAlert('Failed to start session', 'Please try again.');
                          return;
                        }
                        onClose();
                        onNavigateToMessages(session.memberId);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Begin session"
                    >
                      {startSession.isPending ? (
                        <ActivityIndicator size="small" color="#FFFFFF" />
                      ) : (
                        <Text style={detailModalStyles.beginText}>Begin Session</Text>
                      )}
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={detailModalStyles.proposeBtn}
                      onPress={() => {
                        onClose();
                        onProposeNewTime(session);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Propose a new time"
                    >
                      <Text style={detailModalStyles.proposeBtnText}>Propose New Time</Text>
                    </TouchableOpacity>
                  </View>
                ) : !isPending ? (
                  <TouchableOpacity
                    style={detailModalStyles.openProfileBtn}
                    onPress={() => {
                      onClose();
                      onOpenProfile(session.memberId);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${session.memberName ?? 'member'} profile`}
                  >
                    <User size={14} color="#FFFFFF" />
                    <Text style={detailModalStyles.openProfileText}>Open Member Profile</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          </View>
        </Modal>
      <RemoveSessionConfirmModal
        visible={removeConfirmOpen}
        isPending={cancelSession.isPending}
        onCancel={() => setRemoveConfirmOpen(false)}
        onConfirm={async () => {
          try {
            await cancelSession.mutateAsync(session.id);
            setRemoveConfirmOpen(false);
            onClose();
          } catch {
            // useCancelSession surfaces the error via its onError alert; keep
            // the confirm dialog open so the CHW can retry.
          }
        }}
      />
      </>
  );
}

const detailModalStyles = StyleSheet.create({
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
    maxHeight: '85%',
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
  headerLeft: {
    flex: 1,
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
    flex: 1,
  },
  bodyContent: {
    padding: spacing.xl,
    gap: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  avatarCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: tokens.primary + '15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 20,
    color: '#1E3320',
    flex: 1,
  },
  statusBadge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 100,
    borderWidth: 1,
  },
  statusText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
  },
  detailsCard: {
    backgroundColor: '#F9FAFB',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: '#F3F4F6',
    overflow: 'hidden',
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  detailContent: {
    flex: 1,
    gap: 2,
  },
  detailLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  resourceNeedsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  resourceNeedChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  resourceNeedChipText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
  },
  detailValue: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#1E3320',
    lineHeight: 20,
  },
  divider: {
    height: 1,
    backgroundColor: '#F3F4F6',
    marginHorizontal: spacing.lg,
  },
  footer: {
    padding: spacing.xl,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  openProfileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: tokens.primary,
    paddingVertical: 12,
    borderRadius: radius.md,
    minHeight: 44,
  },
  openProfileText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
  confirmRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  declineBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    backgroundColor: '#FEF2F2',
    minHeight: 44,
  },
  declineText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#b91c1c',
  },
  confirmBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: tokens.primary,
    minHeight: 44,
  },
  confirmText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
  scheduledActions: {
    gap: spacing.sm,
  },
  beginBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: tokens.emerald700,
    paddingVertical: 12,
    borderRadius: radius.md,
    minHeight: 44,
  },
  beginText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  proposeBtn: {
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
  proposeBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#374151',
  },
  removeBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    backgroundColor: '#FEF2F2',
    minHeight: 44,
  },
  removeBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#b91c1c',
  },
});

// ─── Remove Session Confirm Modal ─────────────────────────────────────────────

interface RemoveSessionConfirmModalProps {
  visible: boolean;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Yes/No confirmation shown before removing (cancelling) an upcoming scheduled
 * session — mirrors MemberProfileScreen's RefuseServicesConfirmModal pattern
 * (an in-app Modal, never window.confirm/Alert.alert, so the prompt is
 * consistent across web + native).
 */
function RemoveSessionConfirmModal({
  visible,
  isPending,
  onConfirm,
  onCancel,
}: RemoveSessionConfirmModalProps): React.JSX.Element {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      accessibilityViewIsModal
    >
      <View style={removeModalStyles.overlay}>
        <View style={removeModalStyles.dialog}>
          <Text style={removeModalStyles.title}>Remove this scheduled session?</Text>
          <Text style={removeModalStyles.body}>
            The member will be notified. This can't be undone.
          </Text>
          <View style={removeModalStyles.actions}>
            <TouchableOpacity
              style={removeModalStyles.cancelBtn}
              onPress={onCancel}
              disabled={isPending}
              accessibilityRole="button"
              accessibilityLabel="No, keep session"
            >
              <Text style={removeModalStyles.cancelBtnText}>No, Keep It</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[removeModalStyles.confirmBtn, isPending && { opacity: 0.6 }]}
              onPress={onConfirm}
              disabled={isPending}
              accessibilityRole="button"
              accessibilityLabel="Yes, remove session"
            >
              {isPending ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={removeModalStyles.confirmBtnText}>Yes, Remove</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const removeModalStyles = StyleSheet.create({
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

// ─── Schedule Session Modal ───────────────────────────────────────────────────

type ScheduleSessionMode = 'in_person' | 'virtual' | 'phone';

// 'virtual' (Video) removed from NEW-session selection per product decision
// 2026-07-14 — the ScheduleSessionMode union and the label/icon maps keep it
// so existing virtual sessions still render correctly (grandfathered).
const SESSION_MODES: { value: ScheduleSessionMode; label: string }[] = [
  { value: 'phone', label: 'Phone' },
  { value: 'in_person', label: 'In-Person' },
];

interface ScheduleSessionModalProps {
  visible: boolean;
  onClose: () => void;
  members: MembersRosterItem[];
  isLoadingMembers: boolean;
  /** Reschedule/"Propose New Time" mode — locks the member picker to this id. */
  prefillMemberId?: string;
  /** Display name shown for the locked member (avoids a members-list lookup). */
  prefillMemberName?: string;
  /** "MM/DD/YYYY" — matches the Date field's own input format. */
  prefillDate?: string;
  /** "h:mm AM/PM" — matches the Start/End Time fields' own input format. */
  prefillStartTime?: string;
  prefillEndTime?: string;
  /** Resource Needs verticals carried over from the original session when
   *  opening in "Propose New Time" mode (QA2 A2 #15) — so counter-offering a
   *  new time doesn't silently drop the member's already-recorded needs. */
  prefillResourceNeeds?: Vertical[];
  /**
   * When set, the modal is in reschedule/"Propose New Time" mode: the member
   * is locked, schedulingStatus is forced to 'pending' (the member must
   * confirm the CHW's proposed time), and — only after the new booking
   * succeeds — this session id is declined. Mirrors MemberCalendarScreen's
   * replaceSessionId pattern: the old session is cancelled AFTER the new one
   * is confirmed booked, so a failed re-book never loses the original
   * session.
   */
  replaceSessionId?: string;
}

/**
 * Modal for scheduling a session with one of the CHW's members.
 *
 * Collects: member (searchable list), session type, date, start time, end
 * time, and optional Resource Needs (a multi-select of verticals, e.g.
 * Housing/Food/Transportation). Submits via useScheduleSession().
 *
 * QA2 A2 #14 — the Confirmed/Pending status picker was removed: every new
 * CHW-scheduled session is submitted with `scheduling_status: 'pending'`
 * explicitly (never relying on the backend's 'confirmed' default), so it
 * always lands in the member's Pending Session Requests for approval, the
 * same as a member-initiated request and the same as "Propose New Time".
 *
 * Doubles as the "Propose New Time" reschedule flow for a member-requested
 * pending session (see `replaceSessionId` above) — opened from
 * PendingRequestsList with the member locked and the original time prefilled.
 */
function ScheduleSessionModal({
  visible,
  onClose,
  members,
  isLoadingMembers,
  prefillMemberId,
  prefillMemberName,
  prefillDate,
  prefillStartTime,
  prefillEndTime,
  prefillResourceNeeds,
  replaceSessionId,
}: ScheduleSessionModalProps): React.JSX.Element {
  const { mutateAsync, isPending } = useScheduleSession();
  const declineOldSession = useDeclineSession();
  const isProposeMode = !!replaceSessionId;

  // Form state
  const [memberSearch, setMemberSearch] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState<string>('');
  const [selectedMemberName, setSelectedMemberName] = useState<string>('');
  const [sessionMode, setSessionMode] = useState<ScheduleSessionMode>('in_person');
  const [dateInput, setDateInput] = useState<string>(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const dd = String(tomorrow.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${tomorrow.getFullYear()}`;
  });
  const [startTimeInput, setStartTimeInput] = useState('10:00 AM');
  const [endTimeInput, setEndTimeInput] = useState('11:00 AM');
  // Epic L — replaces the free-text Notes field with a Resource Needs
  // multi-select. A Set gives O(1) toggle/has checks for the chip grid.
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

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.displayName.toLowerCase().includes(q));
  }, [members, memberSearch]);

  const resetForm = useCallback(() => {
    setMemberSearch('');
    setSelectedMemberId('');
    setSelectedMemberName('');
    setSessionMode('in_person');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const dd = String(tomorrow.getDate()).padStart(2, '0');
    setDateInput(`${mm}/${dd}/${tomorrow.getFullYear()}`);
    setStartTimeInput('10:00 AM');
    setEndTimeInput('11:00 AM');
    setResourceNeeds(new Set());
    setFieldError(null);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  // Propose New Time: seed the form from the request's member + scheduled
  // time whenever the modal opens in reschedule mode. The modal stays
  // mounted between opens (visible toggles), so this can't just be an
  // initializer — it must re-run each time `visible` flips true.
  useEffect(() => {
    if (!visible || !replaceSessionId) return;
    setSelectedMemberId(prefillMemberId ?? '');
    setSelectedMemberName(prefillMemberName ?? '');
    setMemberSearch('');
    if (prefillDate) setDateInput(prefillDate);
    if (prefillStartTime) setStartTimeInput(prefillStartTime);
    if (prefillEndTime) setEndTimeInput(prefillEndTime);
    // QA2 A2 #15 — seed from the ORIGINAL session's resourceNeeds instead of
    // resetting to empty, so counter-offering a new time doesn't silently
    // drop needs the member already has on record.
    setResourceNeeds(new Set(prefillResourceNeeds ?? []));
    setFieldError(null);
  }, [
    visible,
    replaceSessionId,
    prefillMemberId,
    prefillMemberName,
    prefillDate,
    prefillStartTime,
    prefillEndTime,
    prefillResourceNeeds,
  ]);

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

  const handleSubmit = useCallback(async () => {
    setFieldError(null);

    if (!selectedMemberId) {
      setFieldError('Please select a member.');
      return;
    }

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
        memberId: selectedMemberId,
        scheduledAt,
        scheduledEndAt,
        mode: sessionMode,
        // QA2 A2 #14 — every CHW-scheduled session (new OR Propose New Time)
        // is ALWAYS submitted as an explicit 'pending' request: the FE never
        // relies on the backend's 'confirmed' default, and the removed
        // Status picker used to let a CHW skip the member's approval step
        // entirely. Every session now lands in the member's Pending Session
        // Requests, same as a member-initiated request.
        schedulingStatus: 'pending',
        resourceNeeds: Array.from(resourceNeeds),
      });
      // Reschedule: only after the new booking succeeds do we decline the
      // original pending request, so a failure never leaves the member with
      // no session at all. Mirrors MemberCalendarScreen's replaceSessionId
      // ordering exactly.
      if (replaceSessionId) {
        try {
          await declineOldSession.mutateAsync(replaceSessionId);
        } catch (declineErr) {
          // QA2 A2 #2 — surface this instead of swallowing it silently: the
          // new session booked successfully, but the stale original is still
          // live and needs manual cleanup. Log for diagnostics and show a
          // non-blocking warning (the new booking already succeeded, so this
          // must not block handleClose() below).
          console.error(
            '[ScheduleSessionModal] Failed to decline the original session after a successful Propose New Time re-book:',
            declineErr,
          );
          showAlert(
            'New time proposed, but the old request is still pending',
            'The new session was booked, but we could not automatically remove the original request. Please decline it manually from Session Details.',
          );
        }
      }
      handleClose();
    } catch {
      // Error alert handled by useScheduleSession onError
    }
  }, [
    selectedMemberId,
    dateInput,
    startTimeInput,
    endTimeInput,
    sessionMode,
    resourceNeeds,
    mutateAsync,
    handleClose,
    replaceSessionId,
    declineOldSession,
  ]);

  const canSubmit = selectedMemberId.length > 0 && !isPending && !declineOldSession.isPending;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
      accessibilityViewIsModal
    >
      <View style={scheduleModalStyles.overlay}>
        <View style={scheduleModalStyles.sheet}>
          {/* Header */}
          <View style={scheduleModalStyles.header}>
            <Text style={scheduleModalStyles.headerTitle}>
              {isProposeMode ? 'Propose New Time' : 'Schedule Session'}
            </Text>
            <TouchableOpacity
              style={scheduleModalStyles.closeBtn}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel="Close schedule session modal"
            >
              <X size={18} color={tokens.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={scheduleModalStyles.body}
            contentContainerStyle={scheduleModalStyles.bodyContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Member picker */}
            <View style={scheduleModalStyles.field}>
              <Text style={scheduleModalStyles.fieldLabel}>Member *</Text>
              {selectedMemberId ? (
                <View style={scheduleModalStyles.selectedMember}>
                  <View style={scheduleModalStyles.selectedMemberAvatar}>
                    <User size={14} color={tokens.primary} />
                  </View>
                  <Text style={scheduleModalStyles.selectedMemberName}>{selectedMemberName}</Text>
                  {/* Propose New Time reschedules the SAME member's request —
                      the CHW can't swap who it's with, so the clear button is
                      hidden while the member is locked. */}
                  {!isProposeMode && (
                    <TouchableOpacity
                      onPress={() => { setSelectedMemberId(''); setSelectedMemberName(''); setMemberSearch(''); }}
                      accessibilityRole="button"
                      accessibilityLabel="Clear member selection"
                    >
                      <X size={14} color={tokens.textSecondary} />
                    </TouchableOpacity>
                  )}
                </View>
              ) : (
                <>
                  <TextInput
                    style={scheduleModalStyles.searchInput}
                    value={memberSearch}
                    onChangeText={setMemberSearch}
                    placeholder="Search members..."
                    placeholderTextColor="#9CA3AF"
                    accessibilityLabel="Search members"
                    autoCapitalize="words"
                  />
                  {isLoadingMembers ? (
                    <View style={scheduleModalStyles.loadingRow}>
                      <ActivityIndicator size="small" color={tokens.primary} />
                      <Text style={scheduleModalStyles.loadingText}>Loading members...</Text>
                    </View>
                  ) : filteredMembers.length === 0 ? (
                    <View style={scheduleModalStyles.emptyHint}>
                      <Text style={scheduleModalStyles.emptyHintText}>
                        {memberSearch.trim() ? 'No members match your search.' : 'No members found.'}
                      </Text>
                    </View>
                  ) : (
                    <View style={scheduleModalStyles.memberList}>
                      {filteredMembers.slice(0, 6).map((member) => (
                        <TouchableOpacity
                          key={member.id}
                          style={scheduleModalStyles.memberRow}
                          onPress={() => {
                            setSelectedMemberId(member.id);
                            setSelectedMemberName(member.displayName);
                            setMemberSearch('');
                          }}
                          accessibilityRole="button"
                          accessibilityLabel={`Select ${member.displayName}`}
                        >
                          <View style={scheduleModalStyles.memberAvatar}>
                            <Text style={scheduleModalStyles.memberInitials}>
                              {member.avatarInitials}
                            </Text>
                          </View>
                          <Text style={scheduleModalStyles.memberName}>{member.displayName}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </>
              )}
            </View>

            {/* Session Type */}
            <View style={scheduleModalStyles.field}>
              <Text style={scheduleModalStyles.fieldLabel}>Session Type</Text>
              <View style={scheduleModalStyles.segmentRow}>
                {SESSION_MODES.map(({ value, label }) => {
                  const isActive = sessionMode === value;
                  return (
                    <TouchableOpacity
                      key={value}
                      style={[scheduleModalStyles.segmentBtn, isActive && scheduleModalStyles.segmentBtnActive]}
                      onPress={() => setSessionMode(value)}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: isActive }}
                      accessibilityLabel={label}
                    >
                      <SessionModeIcon mode={value} size={12} color={isActive ? '#FFFFFF' : '#6B7280'} />
                      <Text style={[scheduleModalStyles.segmentText, isActive && scheduleModalStyles.segmentTextActive]}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Date */}
            <View style={scheduleModalStyles.field}>
              <Text style={scheduleModalStyles.fieldLabel}>Date</Text>
              <TextInput
                style={scheduleModalStyles.textInput}
                value={dateInput}
                onChangeText={setDateInput}
                placeholder="MM/DD/YYYY"
                placeholderTextColor="#9CA3AF"
                accessibilityLabel="Session date"
                keyboardType="numbers-and-punctuation"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            {/* Start + End Time */}
            <View style={scheduleModalStyles.timeRow}>
              <View style={[scheduleModalStyles.field, { flex: 1 }]}>
                <Text style={scheduleModalStyles.fieldLabel}>Start Time</Text>
                <TextInput
                  style={scheduleModalStyles.textInput}
                  value={startTimeInput}
                  onChangeText={setStartTimeInput}
                  placeholder="10:00 AM"
                  placeholderTextColor="#9CA3AF"
                  accessibilityLabel="Session start time"
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
              </View>
              <View style={[scheduleModalStyles.field, { flex: 1 }]}>
                <Text style={scheduleModalStyles.fieldLabel}>End Time</Text>
                <TextInput
                  style={scheduleModalStyles.textInput}
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

            {/* Status — QA2 A2 #14: the Confirmed/Pending toggle was removed.
                Every CHW-scheduled session (new or Propose New Time) is
                ALWAYS submitted as 'pending' so it lands in the member's
                Pending Session Requests for approval — this is now a fixed
                fact of the flow, not a choice, so it's surfaced as a plain
                hint instead of a picker. */}
            <View style={scheduleModalStyles.field}>
              <Text style={scheduleModalStyles.fieldLabel}>Status</Text>
              <Text style={scheduleModalStyles.proposeHint}>
                Sent as a pending request — {selectedMemberName || 'the member'} will need to
                confirm this time.
              </Text>
            </View>

            {/* Resource Needs (optional) — Epic L: replaces the free-text
                Notes field with a multi-select of the same verticals used
                elsewhere in the app (member requests, filters, etc). Reuses
                lib/verticals.ts as the single source of truth so this list
                never drifts from the backend enum. */}
            <View style={scheduleModalStyles.field}>
              <Text style={scheduleModalStyles.fieldLabel}>Resource Needs (optional)</Text>
              <View style={scheduleModalStyles.chipRow} accessibilityLabel="Resource needs">
                {VERTICAL_PICKER_OPTIONS.map((opt) => {
                  const isSelected = resourceNeeds.has(opt.key);
                  const color = VERTICAL_COLOR[opt.key];
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      style={[
                        scheduleModalStyles.chip,
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
                      <Text style={scheduleModalStyles.chipEmoji}>{opt.emoji}</Text>
                      <Text
                        style={[
                          scheduleModalStyles.chipText,
                          isSelected && { color, fontFamily: 'PlusJakartaSans_600SemiBold' },
                        ]}
                      >
                        {opt.label}
                      </Text>
                      {isSelected ? (
                        <Text style={[scheduleModalStyles.chipCheck, { color }]}>✓</Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Inline error */}
            {fieldError != null ? (
              <View style={scheduleModalStyles.errorBanner}>
                <AlertCircle size={14} color={tokens.red700} />
                <Text style={scheduleModalStyles.errorText}>{fieldError}</Text>
              </View>
            ) : null}
          </ScrollView>

          {/* Footer actions */}
          <View style={scheduleModalStyles.footer}>
            <TouchableOpacity
              style={scheduleModalStyles.cancelBtn}
              onPress={handleClose}
              accessibilityRole="button"
            >
              <Text style={scheduleModalStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[scheduleModalStyles.submitBtn, !canSubmit && scheduleModalStyles.submitBtnDisabled]}
              onPress={() => void handleSubmit()}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityLabel={isProposeMode ? 'Propose new time' : 'Schedule session'}
              accessibilityState={{ disabled: !canSubmit }}
            >
              {isPending || declineOldSession.isPending ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={scheduleModalStyles.submitText}>
                  {isProposeMode ? 'Propose New Time' : 'Schedule Session'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const scheduleModalStyles = StyleSheet.create({
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
    maxWidth: Platform.OS === 'web' ? 520 : undefined,
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
    flex: 1,
  },
  bodyContent: {
    padding: spacing.xl,
    gap: spacing.lg,
    paddingBottom: spacing.xxl,
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
  proposeHint: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 18,
  },
  selectedMember: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tokens.primary,
    backgroundColor: '#F0FDF4',
  },
  selectedMemberAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: tokens.primary + '20',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedMemberName: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#1E3320',
    flex: 1,
  },
  searchInput: {
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
    padding: spacing.md,
    backgroundColor: '#F9FAFB',
    borderRadius: radius.md,
  },
  emptyHintText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
  },
  memberList: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    backgroundColor: '#FFFFFF',
  },
  memberAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: tokens.primary + '15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberInitials: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 12,
    color: tokens.primary,
  },
  memberName: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#1E3320',
    flex: 1,
  },
  segmentRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  segmentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 9,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#FFFFFF',
  },
  segmentBtnActive: {
    borderColor: tokens.primary,
    backgroundColor: tokens.primary,
  },
  segmentText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#6B7280',
  },
  segmentTextActive: {
    color: '#FFFFFF',
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
  // Epic L — Resource Needs chip multi-select, replacing the old free-text
  // Notes field's textInput/notesInput styles.
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
  timeRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: '#FEF2F2',
    borderRadius: radius.md,
    padding: spacing.md,
  },
  errorText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.red700,
    flex: 1,
    lineHeight: 18,
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
    paddingVertical: 11,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  cancelText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#374151',
  },
  submitBtn: {
    flex: 2,
    paddingVertical: 11,
    borderRadius: radius.md,
    backgroundColor: tokens.primary,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  submitBtnDisabled: {
    backgroundColor: '#9CA3AF',
  },
  submitText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
});

// ─── Main Component ───────────────────────────────────────────────────────────

const NOW = new Date();
const TODAY_YEAR = NOW.getFullYear();
const TODAY_MONTH = NOW.getMonth();
const TODAY_DAY = NOW.getDate();

/**
 * CHW Calendar screen — full-width week/day/month view + Schedule Session modal.
 *
 * No right-side rail. The calendar grid occupies 100% of available width.
 * Session cards are positioned in the week grid at their scheduled time.
 * Tapping a session card opens the Session Details modal.
 * The "+ Schedule Session" button opens the member-based scheduling modal.
 */
export function CHWCalendarScreen(): React.JSX.Element {
  const { data: rawSessions, isLoading, error, refetch } = useSessions();
  const { data: rawMembers, isLoading: isLoadingMembers } = useChwMembers();
  const refresh = useRefreshControl([refetch]);
  const navigation = useNavigation();

  // Navigate to a member's full profile from a session detail.
  const handleOpenProfile = useCallback((memberId: string) => {
    (navigation as any).navigate('SessionsStack', {
      screen: 'MemberProfile',
      params: { memberId },
    });
  }, [navigation]);

  // Navigate to Messages for a member — used by SessionDetailsModal's "Begin
  // Session" once the session has actually been started (mirrors
  // CHWMemberProfileScreen.handleNavigateToConversation).
  const handleNavigateToMessages = useCallback((memberId: string) => {
    (navigation as any).navigate('SessionsStack', {
      screen: 'Messages',
      params: { memberId },
    });
  }, [navigation]);

  // View mode: web defaults to 'week'.
  const [viewMode, setViewMode] = useState<CalendarViewMode>(
    Platform.OS === 'web' ? 'week' : 'month',
  );

  // Week anchor — tracks which week is shown in week view.
  const [weekAnchor, setWeekAnchor] = useState(() => new Date(TODAY_YEAR, TODAY_MONTH, TODAY_DAY));
  const weekDays = useMemo(() => getWeekDays(weekAnchor), [weekAnchor]);

  // Month nav state.
  const [currentDate, setCurrentDate] = useState(() => new Date(TODAY_YEAR, TODAY_MONTH, 1));
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const cells = useMemo(() => getMonthCells(year, month), [year, month]);

  // Modal state.
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
  const [detailSession, setDetailSession] = useState<SessionData | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);

  // "Propose New Time" — the pending request currently being rescheduled, if
  // any. Set from PendingRequestsList; drives ScheduleSessionModal into its
  // reschedule/prefill mode (see replaceSessionId prop).
  const [proposeRequest, setProposeRequest] = useState<SessionData | null>(null);

  const handleProposeNewTime = useCallback((request: SessionData) => {
    setProposeRequest(request);
  }, []);

  const handleScheduleModalClose = useCallback(() => {
    setIsScheduleModalOpen(false);
    setProposeRequest(null);
  }, []);

  const allSessions = rawSessions ?? [];
  const allMembers = rawMembers ?? [];

  // Member-requested sessions awaiting this CHW's approval → shown as a list
  // above the calendar (soonest first). Excludes the CHW's OWN proposals
  // (proposedBy === 'chw') — those are awaiting the MEMBER's approval, not
  // this CHW's, so they'd otherwise show up in the CHW's own approval queue.
  // Legacy rows with proposedBy null/undefined (scheduled before this field
  // existed) CONTINUE to show here — today's behavior preserved, since the
  // initiator is unknown and the CHW has always been able to act on them.
  const pendingRequests = useMemo(
    () =>
      allSessions
        .filter(
          (s) =>
            s.status === 'scheduled' &&
            s.schedulingStatus === 'pending' &&
            s.proposedBy !== 'chw',
        )
        .sort(
          (a, b) =>
            new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime(),
        ),
    [allSessions],
  );

  const sessionsByDate = useMemo(() => groupSessionsByDate(allSessions), [allSessions]);

  // Now reference — stable within a render pass for badge derivation.
  const nowRef = useMemo(() => new Date(), []);

  // Handlers
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

  const handleSessionPress = useCallback((session: SessionData) => {
    setDetailSession(session);
    setIsDetailModalOpen(true);
  }, []);

  // Month-view selected day sessions (for expanded detail under grid)
  const selectedDateKey = selectedDay !== null ? toDateKey(year, month, selectedDay) : null;
  const selectedDaySessions = selectedDateKey ? (sessionsByDate.get(selectedDateKey) ?? []) : [];

  // Week range label
  const weekRangeLabel = useMemo(() => {
    const start = weekDays[0];
    const end = weekDays[6];
    const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
    if (sameMonth) {
      return `${MONTH_NAMES[start.getMonth()]} ${start.getDate()} – ${end.getDate()}, ${end.getFullYear()}`;
    }
    return `${MONTH_NAMES_SHORT[start.getMonth()]} ${start.getDate()} – ${MONTH_NAMES_SHORT[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
  }, [weekDays]);

  // Navigation title for the week/month nav bar
  const navTitle = viewMode === 'month'
    ? `${MONTH_NAMES[month]} ${year}`
    : viewMode === 'week'
    ? weekRangeLabel
    : `${MONTH_NAMES[TODAY_MONTH]} ${TODAY_DAY}, ${TODAY_YEAR}`;

  // Handle prev/next navigation for all modes
  const handlePrev = viewMode === 'week' ? handlePrevWeek : handlePrevMonth;
  const handleNext = viewMode === 'week' ? handleNextWeek : handleNextMonth;

  // Today's sessions (day view)
  const todayKey = toDateKey(TODAY_YEAR, TODAY_MONTH, TODAY_DAY);
  const todaySessions = sessionsByDate.get(todayKey) ?? [];

  // Loading / error states
  if (isLoading) {
    return (
      <AppShell role="chw" activeKey="appointments" userBlock={{ initials: '...', name: '...', role: 'CHW' }}>
        <SafeAreaView style={mainStyles.safe} edges={['top']}>
          <ScrollView style={mainStyles.scroll} contentContainerStyle={mainStyles.content}>
            <LoadingSkeleton variant="card" />
          </ScrollView>
        </SafeAreaView>
      </AppShell>
    );
  }

  if (error) {
    return (
      <AppShell role="chw" activeKey="appointments" userBlock={{ initials: '...', name: '...', role: 'CHW' }}>
        <SafeAreaView style={mainStyles.safe} edges={['top']}>
          <ErrorState message="Failed to load calendar" onRetry={() => void refetch()} />
        </SafeAreaView>
      </AppShell>
    );
  }

  // ─── Header right slot ───────────────────────────────────────────────────────

  const headerRight = (
    <View style={mainStyles.headerRight}>
      {/* View mode toggle */}
      <View style={mainStyles.viewToggle}>
        {(['day', 'week', 'month'] as CalendarViewMode[]).map((mode) => (
          <TouchableOpacity
            key={mode}
            style={[mainStyles.toggleBtn, viewMode === mode && mainStyles.toggleBtnActive]}
            onPress={() => setViewMode(mode)}
            accessibilityRole="button"
            accessibilityState={{ selected: viewMode === mode }}
            accessibilityLabel={`${mode} view`}
          >
            <Text style={[mainStyles.toggleBtnText, viewMode === mode && mainStyles.toggleBtnTextActive]}>
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Schedule Session CTA */}
      <TouchableOpacity
        style={mainStyles.scheduleBtn}
        onPress={() => setIsScheduleModalOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Schedule a new session"
      >
        <Plus size={14} color="#FFFFFF" />
        <Text style={mainStyles.scheduleBtnText}>Schedule Session</Text>
      </TouchableOpacity>
    </View>
  );

  // ─── Calendar card content ───────────────────────────────────────────────────

  const calendarContent = (
    <View style={mainStyles.calendarOuter}>
      {/* Week/Month nav bar */}
      <View style={mainStyles.navBar}>
        <TouchableOpacity
          style={mainStyles.navBtn}
          onPress={handlePrev}
          accessibilityRole="button"
          accessibilityLabel={viewMode === 'week' ? 'Previous week' : 'Previous month'}
        >
          <ChevronLeft size={18} color="#374151" />
        </TouchableOpacity>
        <Text style={mainStyles.navTitle}>{navTitle}</Text>
        <TouchableOpacity
          style={mainStyles.navBtn}
          onPress={handleNext}
          accessibilityRole="button"
          accessibilityLabel={viewMode === 'week' ? 'Next week' : 'Next month'}
        >
          <ChevronRight size={18} color="#374151" />
        </TouchableOpacity>
      </View>

      {/* Grid */}
      {viewMode === 'week' ? (
        <WeekViewGrid
          weekDays={weekDays}
          sessionsByDate={sessionsByDate}
          today={{ year: TODAY_YEAR, month: TODAY_MONTH, day: TODAY_DAY }}
          now={nowRef}
          onSessionPress={handleSessionPress}
        />
      ) : viewMode === 'day' ? (
        <DayViewGrid
          date={new Date(TODAY_YEAR, TODAY_MONTH, TODAY_DAY)}
          sessions={todaySessions}
          now={nowRef}
          onSessionPress={handleSessionPress}
        />
      ) : (
        <>
          <MonthViewGrid
            year={year}
            month={month}
            cells={cells}
            sessionsByDate={sessionsByDate}
            today={{ year: TODAY_YEAR, month: TODAY_MONTH, day: TODAY_DAY }}
            selectedDay={selectedDay}
            onDayPress={handleDayPress}
          />
          {/* Expanded day sessions beneath month grid */}
          {selectedDay !== null ? (
            <View style={mainStyles.dayDetail}>
              <Text style={mainStyles.dayDetailHeading}>
                {MONTH_NAMES[month]} {selectedDay}
              </Text>
              {selectedDaySessions.length === 0 ? (
                <View style={mainStyles.emptyDay}>
                  <CalendarDays size={24} color="#D1D5DB" />
                  <Text style={mainStyles.emptyDayText}>No sessions on this day</Text>
                </View>
              ) : (
                selectedDaySessions.map((session) => {
                  const badge = deriveBadgeStatus(session, nowRef);
                  const badgeStyle = BADGE_COLORS[badge];
                  return (
                    <TouchableOpacity
                      key={session.id}
                      style={mainStyles.monthSessionRow}
                      onPress={() => handleSessionPress(session)}
                      accessibilityRole="button"
                      accessibilityLabel={`Session with ${session.memberName ?? 'member'}`}
                    >
                      <View style={mainStyles.monthSessionLeftBar} />
                      <View style={mainStyles.monthSessionBody}>
                        <Text style={mainStyles.monthSessionTime} numberOfLines={1}>
                          {formatTimeRange(session.scheduledAt, session.scheduledEndAt)}
                        </Text>
                        <Text style={mainStyles.monthSessionMember} numberOfLines={1}>
                          {session.memberName ?? 'Member'}
                        </Text>
                        <View style={mainStyles.monthSessionMeta}>
                          <SessionModeIcon mode={session.mode} size={11} color={tokens.emerald700} />
                          <Text style={mainStyles.monthSessionMode}>{sessionModeLabel(session.mode)}</Text>
                          <View style={[mainStyles.monthBadge, { backgroundColor: badgeStyle.bg, borderColor: badgeStyle.border }]}>
                            <Text style={[mainStyles.monthBadgeText, { color: badgeStyle.text }]}>{badge}</Text>
                          </View>
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                })
              )}
            </View>
          ) : null}
        </>
      )}
    </View>
  );

  // ─── Web layout ──────────────────────────────────────────────────────────────

  if (Platform.OS === 'web') {
    return (
      <AppShell role="chw" activeKey="appointments" userBlock={{ initials: 'C', name: 'CHW', role: 'CHW' }}>
        <View style={webStyles.root}>
          <PageHeader
            title="Calendar"
            subtitle="Your schedule and appointments"
            right={headerRight}
          />

          <PendingRequestsList requests={pendingRequests} onProposeNewTime={handleProposeNewTime} />

          <Card style={webStyles.calendarCard}>
            {calendarContent}
          </Card>
        </View>

        {/* Session Details modal */}
        <SessionDetailsModal
          session={detailSession}
          now={nowRef}
          visible={isDetailModalOpen}
          onClose={() => setIsDetailModalOpen(false)}
          onOpenProfile={handleOpenProfile}
          onNavigateToMessages={handleNavigateToMessages}
          onProposeNewTime={handleProposeNewTime}
        />

        {/* Schedule Session modal — also powers "Propose New Time" (see
            proposeRequest) when opened from a pending request row below. */}
        <ScheduleSessionModal
          visible={isScheduleModalOpen || proposeRequest !== null}
          onClose={handleScheduleModalClose}
          members={allMembers}
          isLoadingMembers={isLoadingMembers}
          prefillMemberId={proposeRequest?.memberId}
          prefillMemberName={proposeRequest?.memberName}
          prefillDate={proposeRequest ? formatDateInputValue(proposeRequest.scheduledAt) : undefined}
          prefillStartTime={proposeRequest ? formatTimeAMPM(proposeRequest.scheduledAt) : undefined}
          prefillEndTime={
            proposeRequest?.scheduledEndAt ? formatTimeAMPM(proposeRequest.scheduledEndAt) : undefined
          }
          prefillResourceNeeds={proposeRequest?.resourceNeeds as Vertical[] | undefined}
          replaceSessionId={proposeRequest?.id}
        />
      </AppShell>
    );
  }

  // ─── Native layout ───────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={mainStyles.safe} edges={['top']}>
      <ScrollView
        style={mainStyles.scroll}
        contentContainerStyle={mainStyles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={refresh.control}
      >
        {/* Page header row */}
        <View style={mainStyles.nativeHeader}>
          <View style={mainStyles.nativeTitleBlock}>
            <Text style={mainStyles.nativeTitle}>Calendar</Text>
            <Text style={mainStyles.nativeSubtitle}>Your schedule and appointments</Text>
          </View>
          {headerRight}
        </View>

        <PendingRequestsList requests={pendingRequests} onProposeNewTime={handleProposeNewTime} />

        {/* Calendar card */}
        <View style={mainStyles.calendarCard}>
          {calendarContent}
        </View>
      </ScrollView>

      {/* Session Details modal */}
      <SessionDetailsModal
        session={detailSession}
        now={nowRef}
        visible={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        onOpenProfile={handleOpenProfile}
        onNavigateToMessages={handleNavigateToMessages}
        onProposeNewTime={handleProposeNewTime}
      />

      {/* Schedule Session modal — also powers "Propose New Time" (see
          proposeRequest) when opened from a pending request row above. */}
      <ScheduleSessionModal
        visible={isScheduleModalOpen || proposeRequest !== null}
        onClose={handleScheduleModalClose}
        members={allMembers}
        isLoadingMembers={isLoadingMembers}
        prefillMemberId={proposeRequest?.memberId}
        prefillMemberName={proposeRequest?.memberName}
        prefillDate={proposeRequest ? formatDateInputValue(proposeRequest.scheduledAt) : undefined}
        prefillStartTime={proposeRequest ? formatTimeAMPM(proposeRequest.scheduledAt) : undefined}
        prefillEndTime={
          proposeRequest?.scheduledEndAt ? formatTimeAMPM(proposeRequest.scheduledEndAt) : undefined
        }
        prefillResourceNeeds={proposeRequest?.resourceNeeds as Vertical[] | undefined}
        replaceSessionId={proposeRequest?.id}
      />
    </SafeAreaView>
  );
}

// ─── Web styles ───────────────────────────────────────────────────────────────

const webStyles = StyleSheet.create({
  root: {
    flex: 1,
  },
  calendarCard: {
    marginBottom: spacing.xxl,
    overflow: 'hidden',
  },
});

// ─── Main styles ──────────────────────────────────────────────────────────────

const mainStyles = StyleSheet.create({
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
  nativeHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: spacing.xl,
    gap: spacing.md,
    flexWrap: 'wrap',
  },
  nativeTitleBlock: {
    gap: 2,
  },
  nativeTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: tokens.textPrimary,
  },
  nativeSubtitle: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.textSecondary,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  viewToggle: {
    flexDirection: 'row',
    backgroundColor: '#F9FAFB',
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: '#E5E7EB',
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
    color: '#6B7280',
  },
  toggleBtnTextActive: {
    color: '#FFFFFF',
  },
  scheduleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: tokens.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    minHeight: 36,
  },
  scheduleBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#FFFFFF',
  },
  calendarOuter: {
    overflow: 'hidden',
  },
  calendarCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    overflow: 'hidden',
    marginBottom: spacing.xl,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.07,
    shadowRadius: 20,
    elevation: 3,
  },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  navBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 15,
    color: '#1E3320',
  },
  dayDetail: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    gap: spacing.sm,
  },
  dayDetailHeading: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  emptyDay: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  emptyDayText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#9CA3AF',
  },
  monthSessionRow: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    overflow: 'hidden',
  },
  monthSessionLeftBar: {
    width: 3,
    backgroundColor: tokens.primary,
    flexShrink: 0,
  },
  monthSessionBody: {
    flex: 1,
    padding: 10,
    gap: 3,
  },
  monthSessionTime: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.emerald700,
    ...numerals.tabular,
  },
  monthSessionMember: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#1E3320',
  },
  monthSessionMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 2,
  },
  monthSessionMode: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.emerald700,
    flex: 1,
  },
  monthBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  monthBadgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
  },
});

// ─── Pending requests list (above the calendar) ───────────────────────────────

interface PendingRequestsListProps {
  requests: SessionData[];
  /** Opens ScheduleSessionModal in "Propose New Time" mode for this request. */
  onProposeNewTime: (request: SessionData) => void;
}

/**
 * Member-requested (pending) sessions awaiting this CHW's approval, listed above
 * the calendar. Each row can be Approved (→ confirmed) or Declined (→ cancelled)
 * inline via useConfirmSession / useDeclineSession, which post a message to the
 * shared thread and refresh both calendars. "Propose New Time" opens the CHW
 * scheduling modal pre-filled with this request's member + time (see
 * onProposeNewTime / ScheduleSessionModal's replaceSessionId mode) so the CHW
 * can counter-offer a different slot instead of just approving or declining.
 */
function PendingRequestsList({
  requests,
  onProposeNewTime,
}: PendingRequestsListProps): React.JSX.Element | null {
  const confirmSession = useConfirmSession();
  const declineSession = useDeclineSession();
  const busy = confirmSession.isPending || declineSession.isPending;

  if (requests.length === 0) return null;

  return (
    <Card style={pendingStyles.card}>
      <Text style={pendingStyles.title}>Pending Session Requests ({requests.length})</Text>
      <Text style={pendingStyles.subtitle}>
        Member-requested sessions awaiting your approval.
      </Text>
      {requests.map((r) => (
        <View key={r.id} style={pendingStyles.row}>
          <View style={pendingStyles.info}>
            <Text style={pendingStyles.name} numberOfLines={1}>
              {r.memberName ?? 'Member'}
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
              onPress={() => onProposeNewTime(r)}
              accessibilityRole="button"
              accessibilityLabel={`Propose new time for ${r.memberName ?? 'member'}`}
            >
              <Text style={pendingStyles.proposeText}>Propose New Time</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[pendingStyles.declineBtn, busy && { opacity: 0.6 }]}
              disabled={busy}
              onPress={() => {
                void declineSession.mutateAsync(r.id).catch(() => {});
              }}
              accessibilityRole="button"
              accessibilityLabel={`Decline request from ${r.memberName ?? 'member'}`}
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
              accessibilityLabel={`Approve request from ${r.memberName ?? 'member'}`}
            >
              <Text style={pendingStyles.approveText}>Approve</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
    </Card>
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

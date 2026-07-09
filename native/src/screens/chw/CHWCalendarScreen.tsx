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
  useChwAvailability,
  useScheduleSession,
  useConfirmSession,
  useDeclineSession,
  type SessionData,
  type MembersRosterItem,
} from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import {
  isHourAvailable,
  type AvailabilityWindows,
} from '../../utils/availabilityShading';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';

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

/** Height in px for a single 1-hour slot in the week grid. */
const SLOT_HEIGHT = 60;

type CalendarViewMode = 'day' | 'week' | 'month';

type SessionMode = 'in_person' | 'virtual' | 'phone';

// ─── Status badge helpers ─────────────────────────────────────────────────────

type SessionBadgeStatus = 'Confirmed' | 'Pending' | 'Completed' | 'Missed';

/**
 * Derives a display status badge from a SessionData row.
 *
 * Priority:
 *  1. completed  → "Completed"
 *  2. cancelled* → "Missed"
 *  3. past scheduled (scheduledAt < now && status === 'scheduled') → "Missed"
 *  4. schedulingStatus 'pending' → "Pending"
 *  5. default → "Confirmed"
 */
function deriveBadgeStatus(session: SessionData, now: Date): SessionBadgeStatus {
  if (session.status === 'completed') return 'Completed';
  if (session.status === 'cancelled' || session.status === 'cancelled_no_consent') return 'Missed';
  if (session.status === 'scheduled' && new Date(session.scheduledAt) < now) return 'Missed';
  if (session.schedulingStatus === 'pending') return 'Pending';
  return 'Confirmed';
}

const BADGE_COLORS: Record<SessionBadgeStatus, { bg: string; text: string; border: string }> = {
  Confirmed: { bg: '#DCFCE7', text: '#15803D', border: '#BBF7D0' },
  Pending: { bg: '#FEF9C3', text: '#A16207', border: '#FDE68A' },
  Completed: { bg: '#F3F4F6', text: '#374151', border: '#E5E7EB' },
  Missed: { bg: '#FEE2E2', text: '#B91C1C', border: '#FECACA' },
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
 * Converts a local Date to a YYYY-MM-DDTHH:mm string for datetime-local inputs.
 */
function toISODateTimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Groups SessionData[] by their local calendar date key (YYYY-MM-DD).
 */
function groupSessionsByDate(sessions: SessionData[]): Map<string, SessionData[]> {
  const map = new Map<string, SessionData[]>();
  for (const session of sessions) {
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
              {/* Hour grid lines — greyed outside the CHW's working hours. */}
              {WEEK_VIEW_HOURS.map((hour) => {
                const unavailable =
                  availabilityWindows !== undefined &&
                  !isHourAvailable(availabilityWindows, date, hour);
                return (
                  <View
                    key={hour}
                    style={[weekStyles.hourLine, unavailable && weekStyles.hourUnavailable]}
                  />
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
              />
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

const CELL_SIZE = 52;

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
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayNumberToday: {
    backgroundColor: tokens.primary,
  },
  dayText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
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
}

function SessionDetailsModal({
  session,
  now,
  visible,
  onClose,
  onOpenProfile,
}: SessionDetailsModalProps): React.JSX.Element {
  // Hooks must run unconditionally, before the early return below.
  const confirmSession = useConfirmSession();
  const declineSession = useDeclineSession();
  const actionPending = confirmSession.isPending || declineSession.isPending;

  if (!session) return <View />;

  const badge = deriveBadgeStatus(session, now);
  const badgeStyle = BADGE_COLORS[badge];
  const isPending = badge === 'Pending';

  return (
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
              ) : badge === 'Missed' ? (
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

              {session.notes ? (
                <>
                  <View style={detailModalStyles.divider} />
                  <View style={detailModalStyles.detailRow}>
                    <View style={{ width: 14, alignItems: 'center' }}>
                      <Text style={{ fontSize: 14 }}>📝</Text>
                    </View>
                    <View style={detailModalStyles.detailContent}>
                      <Text style={detailModalStyles.detailLabel}>Notes</Text>
                      <Text style={detailModalStyles.detailValue}>{session.notes}</Text>
                    </View>
                  </View>
                </>
              ) : null}
            </View>
          </ScrollView>

          {/* Footer */}
          <View style={detailModalStyles.footer}>
            {/* Confirm / Decline — only for a member-requested pending session. */}
            {isPending && (
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
          </View>
        </View>
      </View>
    </Modal>
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
});

// ─── Schedule Session Modal ───────────────────────────────────────────────────

type ScheduleSessionMode = 'in_person' | 'virtual' | 'phone';

const SESSION_MODES: { value: ScheduleSessionMode; label: string }[] = [
  { value: 'phone', label: 'Phone' },
  { value: 'in_person', label: 'In-Person' },
  { value: 'virtual', label: 'Video' },
];

const SCHEDULING_STATUS_OPTIONS: { value: 'confirmed' | 'pending'; label: string }[] = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'pending', label: 'Pending' },
];

interface ScheduleSessionModalProps {
  visible: boolean;
  onClose: () => void;
  members: MembersRosterItem[];
  isLoadingMembers: boolean;
}

/**
 * Modal for scheduling a session with one of the CHW's members.
 *
 * Collects: member (searchable list), session type, date, start time, end time,
 * scheduling status, and optional notes. Submits via useScheduleSession().
 */
function ScheduleSessionModal({
  visible,
  onClose,
  members,
  isLoadingMembers,
}: ScheduleSessionModalProps): React.JSX.Element {
  const { mutateAsync, isPending } = useScheduleSession();

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
  const [schedulingStatus, setSchedulingStatus] = useState<'confirmed' | 'pending'>('confirmed');
  const [notes, setNotes] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

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
    setSchedulingStatus('confirmed');
    setNotes('');
    setFieldError(null);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

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
        schedulingStatus,
        notes: notes.trim() || undefined,
      });
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
    schedulingStatus,
    notes,
    mutateAsync,
    handleClose,
  ]);

  const canSubmit = selectedMemberId.length > 0 && !isPending;

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
            <Text style={scheduleModalStyles.headerTitle}>Schedule Session</Text>
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
                  <TouchableOpacity
                    onPress={() => { setSelectedMemberId(''); setSelectedMemberName(''); setMemberSearch(''); }}
                    accessibilityRole="button"
                    accessibilityLabel="Clear member selection"
                  >
                    <X size={14} color={tokens.textSecondary} />
                  </TouchableOpacity>
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

            {/* Status */}
            <View style={scheduleModalStyles.field}>
              <Text style={scheduleModalStyles.fieldLabel}>Status</Text>
              <View style={scheduleModalStyles.segmentRow}>
                {SCHEDULING_STATUS_OPTIONS.map(({ value, label }) => {
                  const isActive = schedulingStatus === value;
                  return (
                    <TouchableOpacity
                      key={value}
                      style={[scheduleModalStyles.segmentBtn, isActive && scheduleModalStyles.segmentBtnActive]}
                      onPress={() => setSchedulingStatus(value)}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: isActive }}
                      accessibilityLabel={label}
                    >
                      <Text style={[scheduleModalStyles.segmentText, isActive && scheduleModalStyles.segmentTextActive]}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Notes (optional) */}
            <View style={scheduleModalStyles.field}>
              <Text style={scheduleModalStyles.fieldLabel}>Notes (optional)</Text>
              <TextInput
                style={[scheduleModalStyles.textInput, scheduleModalStyles.notesInput]}
                value={notes}
                onChangeText={setNotes}
                placeholder="Add any notes about this session..."
                placeholderTextColor="#9CA3AF"
                accessibilityLabel="Session notes"
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />
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
              accessibilityLabel="Schedule session"
              accessibilityState={{ disabled: !canSubmit }}
            >
              {isPending ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={scheduleModalStyles.submitText}>Schedule Session</Text>
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
  notesInput: {
    minHeight: 80,
    paddingTop: 10,
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

  // The CHW's own working hours → grey out off-days/off-hours on the grid.
  const availabilityQuery = useChwAvailability();
  const ownWindows = availabilityQuery.data?.availabilityWindows as
    | AvailabilityWindows
    | undefined;
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

  const allSessions = rawSessions ?? [];
  const allMembers = rawMembers ?? [];

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
          availabilityWindows={ownWindows}
        />
      ) : viewMode === 'day' ? (
        <DayViewGrid
          date={new Date(TODAY_YEAR, TODAY_MONTH, TODAY_DAY)}
          sessions={todaySessions}
          now={nowRef}
          onSessionPress={handleSessionPress}
          availabilityWindows={ownWindows}
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
        />

        {/* Schedule Session modal */}
        <ScheduleSessionModal
          visible={isScheduleModalOpen}
          onClose={() => setIsScheduleModalOpen(false)}
          members={allMembers}
          isLoadingMembers={isLoadingMembers}
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
      />

      {/* Schedule Session modal */}
      <ScheduleSessionModal
        visible={isScheduleModalOpen}
        onClose={() => setIsScheduleModalOpen(false)}
        members={allMembers}
        isLoadingMembers={isLoadingMembers}
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

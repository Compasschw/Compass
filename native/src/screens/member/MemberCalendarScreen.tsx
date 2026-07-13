/**
 * MemberCalendarScreen — read-only Appointments view mirroring CHWCalendarScreen.
 *
 * Web experience:
 *  - Week / Day / Month toggle in the PageHeader right slot
 *  - Full-width calendar grid (no right rail)
 *  - Week view: 7 columns × hourly rows 8 AM–5 PM with absolute-positioned
 *    session blocks; today highlighted
 *  - Day view: single column for today
 *  - Month view: 7-column grid with per-day session-count badges
 *  - Session block tap → read-only Session Details modal
 *
 * Native experience:
 *  - Simple Upcoming / Past list with status badges + pull-to-refresh
 *
 * Member POV (read-only) vs CHW:
 *  - No scheduling button/modal and no member roster picker
 *  - Session blocks / detail show the CHW name + vertical (the member's
 *    counterpart is the CHW), never a member name
 *  - No member-profile action — members request sessions via Find a CHW
 *
 * Data: useSessions() → /sessions/ — backend auto-scopes to the signed-in member.
 *
 * The grid helpers, badge mapping, SessionCard look, and Session Details modal
 * are PORTED (copied + adapted) from CHWCalendarScreen rather than imported, to
 * keep the CHW screen byte-for-byte unchanged while the member POV diverges.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Modal,
} from 'react-native';
import {
  CalendarDays,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Phone,
  Video,
  Users,
  X,
  CheckCircle,
  AlertCircle,
  User,
  Tag,
} from 'lucide-react-native';
import {
  useNavigation,
  useRoute,
  type NavigationProp,
  type RouteProp,
} from '@react-navigation/native';

import { colors as tokens, numerals, spacing, radius } from '../../theme/tokens';
import { verticalLabels, type Vertical } from '../../data/mock';
import {
  useSessions,
  useScheduleSession,
  useChwAvailableSlots,
  useMemberFacingCHWProfile,
  useCancelSession,
  type SessionData,
} from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import {
  isHourAvailable,
  type AvailabilityWindows,
} from '../../utils/availabilityShading';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { AppShell, PageHeader, Card, SectionHeader, PageWrap } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import type { MemberTabParamList } from '../../navigation/MemberTabNavigator';

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

/**
 * Height in px for a single 1-hour slot in the week grid. Matched to the CHW
 * calendar (96px) so half-hour session blocks (SLOT_HEIGHT/2 = 48px) are easy
 * to read and event labels aren't cramped against the hour line.
 */
const SLOT_HEIGHT = 96;

type CalendarViewMode = 'day' | 'week' | 'month';

const NOW = new Date();
const TODAY_YEAR = NOW.getFullYear();
const TODAY_MONTH = NOW.getMonth();
const TODAY_DAY = NOW.getDate();

// ─── Status badge helpers (ported from CHWCalendarScreen) ─────────────────────

export type SessionBadgeStatus = 'Confirmed' | 'Pending' | 'Completed' | 'Cancelled' | 'Missed';

/** Minimal shape needed to derive a badge — satisfied by both SessionData
 *  (web grid) and MemberSessionEvent (native list). */
interface BadgeSource {
  status: string;
  schedulingStatus?: 'confirmed' | 'pending' | null;
  scheduledAt: string;
}

/**
 * Derives a display status badge from a session row, reflecting the
 * session's REAL status — no inferred/hardcoded "Missed" for a session that
 * was merely never started (see point 5 below).
 *
 * Priority:
 *  1. completed → "Completed"
 *  2. no_show (Epic O2 — CHW began the session but the member never
 *     attended) → "Missed"
 *  3. cancelled/cancelled_no_consent (CHW or member cancelled/removed it) → "Cancelled"
 *  4. schedulingStatus 'pending' (awaiting Confirm/Decline) → "Pending"
 *  5. default (scheduled — upcoming OR past-but-never-started) → "Confirmed"
 *
 * A past session that stayed `scheduled` (the CHW never began it) is
 * intentionally still "Confirmed" here rather than "Missed" — the "Missed"
 * tag is reserved for the distinct, explicit no_show signal (Epic O2) that
 * the CHW actually began the session and the member failed to attend.
 * Silently relabeling every past-and-not-started session as "Missed" would
 * be misleading.
 */
export function deriveBadgeStatus(session: BadgeSource, now: Date): SessionBadgeStatus {
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

// ─── Icon / label helpers (ported) ────────────────────────────────────────────

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
  const c = colorProp ?? tokens.textMuted;
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

/** Human-readable label for a vertical key (falls back to the raw key). */
function verticalLabel(vertical?: string): string {
  if (!vertical) return '';
  return verticalLabels[vertical as Vertical] ?? vertical;
}

/** First name from a full CHW display name, defaulting to "Your CHW". */
function chwDisplayName(chwName?: string): string {
  return chwName && chwName.trim().length > 0 ? chwName : 'Your CHW';
}

// ─── Grid math helpers (ported) ───────────────────────────────────────────────

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

/** Formats an hour integer (24h) → "8 AM" / "12 PM" etc. */
function formatHourLabel(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

/** Formats an ISO datetime string to "10:00 AM" local time. */
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

/** Formats an ISO datetime string to a short date label: "Fri, Jun 20, 2026". */
function formatDateLabel(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** Groups SessionData[] by their local calendar date key (YYYY-MM-DD). */
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

// ─── Member session event (native list) ───────────────────────────────────────

/**
 * Lightweight derived event for the native Upcoming/Past list. Carries the raw
 * status fields so the list can render the same badge as the web grid.
 */
interface MemberSessionEvent {
  id: string;
  /** Local YYYY-MM-DD used for upcoming/past bucketing + sort. */
  date: string;
  /** Local HH:MM (24h) used for sort. */
  startTime: string;
  chwName?: string;
  vertical: string;
  mode: string;
  status: string;
  schedulingStatus?: 'confirmed' | 'pending' | null;
  scheduledAt: string;
  scheduledEndAt?: string | null;
}

/**
 * Derives MemberSessionEvent records from the member's sessions array.
 * Output carries the status fields the badge mapping needs.
 */
function deriveSessionEvents(sessions: SessionData[]): MemberSessionEvent[] {
  return sessions.map((session) => {
    const dt = new Date(session.scheduledAt);
    const date = toDateKey(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const hh = String(dt.getHours()).padStart(2, '0');
    const min = String(dt.getMinutes()).padStart(2, '0');
    return {
      id: `member-sess-${session.id}`,
      date,
      startTime: `${hh}:${min}`,
      chwName: session.chwName,
      vertical: session.vertical,
      mode: session.mode,
      status: session.status,
      schedulingStatus: session.schedulingStatus,
      scheduledAt: session.scheduledAt,
      scheduledEndAt: session.scheduledEndAt,
    };
  });
}

/**
 * Splits derived events into upcoming (>= now) and past buckets, sorted.
 */
function splitUpcomingPast(
  events: MemberSessionEvent[],
  nowIso: string,
): { upcoming: MemberSessionEvent[]; past: MemberSessionEvent[] } {
  const upcoming: MemberSessionEvent[] = [];
  const past: MemberSessionEvent[] = [];
  for (const event of events) {
    const eventIso = `${event.date}T${event.startTime}`;
    if (eventIso >= nowIso) {
      upcoming.push(event);
    } else {
      past.push(event);
    }
  }
  upcoming.sort((a, b) => `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`));
  past.sort((a, b) => `${b.date}T${b.startTime}`.localeCompare(`${a.date}T${a.startTime}`));
  return { upcoming, past };
}

// ─── Session block (week/day grid) — ported from CHW SessionCard ──────────────

interface SessionBlockProps {
  session: SessionData;
  now: Date;
  onPress: (session: SessionData) => void;
}

/**
 * Absolute-positioned block rendered inside a weekly/daily time grid column.
 * Member POV: shows the CHW name + vertical (not a member name).
 */
function SessionBlock({ session, now, onPress }: SessionBlockProps): React.JSX.Element {
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
      accessibilityLabel={`Session with ${chwDisplayName(session.chwName)} at ${formatTimeAMPM(session.scheduledAt)}`}
    >
      <View style={sessionCardStyles.leftBorder} />
      <View style={sessionCardStyles.body}>
        <Text style={[sessionCardStyles.time, numerals.tabular]} numberOfLines={1}>
          {formatTimeAMPM(session.scheduledAt)}
        </Text>
        <Text style={sessionCardStyles.chwName} numberOfLines={1}>
          {chwDisplayName(session.chwName)}
        </Text>
        <View style={sessionCardStyles.typeRow}>
          <SessionModeIcon mode={session.mode} size={10} color={tokens.emerald700} />
          <Text style={sessionCardStyles.typeLabel} numberOfLines={1}>
            {verticalLabel(session.vertical) || sessionModeLabel(session.mode)}
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
  chwName: {
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

// ─── WeekViewGrid (ported) ────────────────────────────────────────────────────

interface WeekViewGridProps {
  weekDays: Date[];
  sessionsByDate: Map<string, SessionData[]>;
  today: { year: number; month: number; day: number };
  now: Date;
  onSessionPress: (session: SessionData) => void;
  /** CHW availability windows — cells outside these hours/days are greyed. */
  availabilityWindows?: AvailabilityWindows;
}

/**
 * Mon–Sun weekly grid with hourly rows (8 AM – 5 PM).
 * Today's date number sits in a green filled circle.
 * Session blocks are positioned absolutely within each column.
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
              {/* Hour grid lines with a lighter :30 half-hour divider —
                  greyed when outside the CHW's working hours. */}
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
              {/* Absolute-position session blocks */}
              <View style={[weekStyles.cardsLayer, { height: totalGridHeight }]}>
                {daySessions.map((session) => (
                  <SessionBlock
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
  // Outside the CHW's working hours — visually blocked for booking.
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

// ─── Day view grid (ported) ───────────────────────────────────────────────────

interface DayViewGridProps {
  date: Date;
  sessions: SessionData[];
  now: Date;
  onSessionPress: (session: SessionData) => void;
  /** CHW availability windows — cells outside these hours are greyed. */
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
              <SessionBlock
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

// ─── Month view grid (ported) ─────────────────────────────────────────────────

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

// ─── Session Details Modal (ported, read-only member POV) ─────────────────────

interface SessionDetailsModalProps {
  session: SessionData | null;
  now: Date;
  visible: boolean;
  onClose: () => void;
  /** Member taps "Edit" on an upcoming session → reschedule flow in the parent. */
  onEdit?: (session: SessionData) => void;
}

/**
 * Session detail modal (member POV): CHW name + vertical, plus Edit/Remove
 * actions for the member's own upcoming (scheduled) sessions.
 */
function SessionDetailsModal({
  session,
  now,
  visible,
  onClose,
  onEdit,
}: SessionDetailsModalProps): React.JSX.Element {
  // Hooks must run unconditionally, before the early return below.
  const cancelSession = useCancelSession();

  if (!session) return <View />;

  const activeSession = session; // non-null past this point
  const badge = deriveBadgeStatus(session, now);
  const badgeStyle = BADGE_COLORS[badge];
  const verticalText = verticalLabel(session.vertical);
  // Only a still-scheduled session can be edited/removed (backend enforces 409).
  const canModify = session.status === 'scheduled';

  const handleRemove = (): void => {
    const doRemove = async (): Promise<void> => {
      try {
        await cancelSession.mutateAsync(activeSession.id);
        onClose();
      } catch {
        // useCancelSession surfaces the error via its onError alert.
      }
    };
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      if (window.confirm('Remove this session? Your CHW will be notified.')) {
        void doRemove();
      }
    } else {
      Alert.alert('Remove session?', 'Your CHW will be notified.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void doRemove() },
      ]);
    }
  };

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
            {/* CHW name */}
            <View style={detailModalStyles.memberRow}>
              <View style={detailModalStyles.avatarCircle}>
                <User size={20} color={tokens.primary} />
              </View>
              <Text style={detailModalStyles.memberName}>
                {chwDisplayName(session.chwName)}
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

              {verticalText ? (
                <>
                  <View style={detailModalStyles.divider} />
                  <View style={detailModalStyles.detailRow}>
                    <Tag size={14} color={tokens.textSecondary} />
                    <View style={detailModalStyles.detailContent}>
                      <Text style={detailModalStyles.detailLabel}>Focus Area</Text>
                      <Text style={detailModalStyles.detailValue}>{verticalText}</Text>
                    </View>
                  </View>
                </>
              ) : null}

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

          {/* Edit / Remove — only for the member's own upcoming sessions. */}
          {canModify && (
            <View style={detailModalStyles.actionFooter}>
              <TouchableOpacity
                style={[
                  detailModalStyles.removeBtn,
                  cancelSession.isPending && { opacity: 0.6 },
                ]}
                onPress={handleRemove}
                disabled={cancelSession.isPending}
                accessibilityRole="button"
                accessibilityLabel="Remove session"
              >
                <Text style={detailModalStyles.removeBtnText}>
                  {cancelSession.isPending ? 'Removing…' : 'Remove'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={detailModalStyles.editBtn}
                onPress={() => {
                  onClose();
                  onEdit?.(activeSession);
                }}
                accessibilityRole="button"
                accessibilityLabel="Edit session"
              >
                <Text style={detailModalStyles.editBtnText}>Edit</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const detailModalStyles = StyleSheet.create({
  actionFooter: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
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
    fontSize: 14,
    fontWeight: '600',
    color: '#b91c1c',
  },
  editBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: '#2563EB',
    minHeight: 44,
  },
  editBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
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
});

// ─── Native list card ─────────────────────────────────────────────────────────

interface MemberListCardProps {
  event: MemberSessionEvent;
  now: Date;
  onPress: (event: MemberSessionEvent) => void;
}

/**
 * Native Upcoming/Past list card — green left strip, CHW name + vertical,
 * time range, and the same status badge as the web grid.
 */
function MemberListCard({ event, now, onPress }: MemberListCardProps): React.JSX.Element {
  const badge = deriveBadgeStatus(event, now);
  const badgeStyle = BADGE_COLORS[badge];
  const verticalText = verticalLabel(event.vertical);

  return (
    <TouchableOpacity
      style={listCardStyles.container}
      onPress={() => onPress(event)}
      accessibilityRole="button"
      accessibilityLabel={`Session with ${chwDisplayName(event.chwName)}`}
    >
      <View style={listCardStyles.colorStrip} />
      <View style={listCardStyles.content}>
        <View style={listCardStyles.titleRow}>
          <Text style={listCardStyles.title} numberOfLines={1}>
            {chwDisplayName(event.chwName)}
          </Text>
          <View style={[listCardStyles.badge, { backgroundColor: badgeStyle.bg, borderColor: badgeStyle.border }]}>
            <Text style={[listCardStyles.badgeText, { color: badgeStyle.text }]}>{badge}</Text>
          </View>
        </View>

        <View style={listCardStyles.metaRow}>
          <Clock color={tokens.textMuted} size={12} />
          <Text style={[listCardStyles.metaText, numerals.tabular]}>
            {formatDateLabel(event.scheduledAt)} · {formatTimeRange(event.scheduledAt, event.scheduledEndAt)}
          </Text>
        </View>

        <View style={listCardStyles.metaRow}>
          <SessionModeIcon mode={event.mode} size={12} color={tokens.textMuted} />
          <Text style={listCardStyles.metaText}>
            {sessionModeLabel(event.mode)}
            {verticalText ? ` · ${verticalText}` : ''}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const listCardStyles = StyleSheet.create({
  container: {
    backgroundColor: tokens.cardBg,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    flexDirection: 'row',
    overflow: 'hidden',
    marginBottom: spacing.md - 2,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  colorStrip: {
    width: 4,
    flexShrink: 0,
    backgroundColor: tokens.primary,
  },
  content: {
    flex: 1,
    padding: spacing.md,
    gap: spacing.xs,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: tokens.textPrimary,
    flex: 1,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexShrink: 0,
  },
  badgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  metaText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.textSecondary,
  },
});

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * Member Appointments screen — full-width Week/Day/Month grid on web (read-only),
 * Upcoming/Past list on native. Backend auto-scopes sessions to the member.
 */
export function MemberCalendarScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const navigation = useNavigation<NavigationProp<MemberTabParamList>>();

  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'Member',
    role: 'Member' as const,
  };

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

  // Detail modal state.
  const [detailSession, setDetailSession] = useState<SessionData | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);

  const sessionsQuery = useSessions();
  const refresh = useRefreshControl([sessionsQuery.refetch]);
  const liveSessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

  // The member's assigned CHW, derived from their sessions — needed to schedule.
  // Scheduling requires an existing relationship, so if there are no sessions
  // yet there is no CHW to book with and the button is hidden.
  const assignedChw = useMemo(() => {
    const withChw = liveSessions.find((s) => Boolean(s.chwId));
    return withChw ? { id: withChw.chwId, name: withChw.chwName ?? 'your CHW' } : null;
  }, [liveSessions]);
  const [isScheduleOpen, setIsScheduleOpen] = useState(false);
  // Session being rescheduled via "Edit". On a successful re-book the old slot
  // is cancelled. null = a fresh booking.
  const [rescheduleSession, setRescheduleSession] = useState<SessionData | null>(null);

  const handleEditSession = useCallback((s: SessionData) => {
    setRescheduleSession(s);
    setIsScheduleOpen(true);
  }, []);

  const handleScheduleClose = useCallback(() => {
    setIsScheduleOpen(false);
    setRescheduleSession(null);
  }, []);

  // Assigned CHW's working hours → grey out off-days/off-hours on the grid.
  const chwProfileQuery = useMemberFacingCHWProfile(assignedChw?.id ?? '');
  const chwWindows = chwProfileQuery.data?.availabilityWindows as
    | AvailabilityWindows
    | undefined;

  // Auto-open the schedule modal when navigated here with { openSchedule: true }
  // (e.g. from the Home "Schedule a session" button). Fires once the assigned
  // CHW is known; the param is cleared so it won't re-open on the next focus.
  const route = useRoute<RouteProp<MemberTabParamList, 'Calendar'>>();
  useEffect(() => {
    if (route.params?.openSchedule && assignedChw) {
      setIsScheduleOpen(true);
      navigation.setParams({ openSchedule: undefined });
    }
  }, [route.params?.openSchedule, assignedChw, navigation]);

  const sessionsByDate = useMemo(() => groupSessionsByDate(liveSessions), [liveSessions]);

  // Now reference — stable within a render pass for badge derivation.
  const nowRef = useMemo(() => new Date(), []);

  // Native derived events.
  const allEvents = useMemo<MemberSessionEvent[]>(
    () => deriveSessionEvents(liveSessions),
    [liveSessions],
  );

  // ── Handlers ──────────────────────────────────────────────────────────────────

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

  const handleEventPress = useCallback(
    (event: MemberSessionEvent) => {
      const match = liveSessions.find((s) => `member-sess-${s.id}` === event.id);
      if (match) {
        setDetailSession(match);
        setIsDetailModalOpen(true);
      }
    },
    [liveSessions],
  );

  const handleFindCHW = useCallback(() => {
    // Navigate into the FindCHW tab's nested stack at the explicit FindList
    // screen — MyCHWScreen (FindMain) auto-renders the existing-CHW profile
    // when the member already has sessions, so 'FindCHW' alone dead-ends there.
    navigation.navigate('FindCHW', { screen: 'FindList' });
  }, [navigation]);

  // ── Derived labels ────────────────────────────────────────────────────────────

  const selectedDateKey = selectedDay !== null ? toDateKey(year, month, selectedDay) : null;
  const selectedDaySessions = selectedDateKey ? (sessionsByDate.get(selectedDateKey) ?? []) : [];

  const weekRangeLabel = useMemo(() => {
    const start = weekDays[0];
    const end = weekDays[6];
    const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
    if (sameMonth) {
      return `${MONTH_NAMES[start.getMonth()]} ${start.getDate()} – ${end.getDate()}, ${end.getFullYear()}`;
    }
    return `${MONTH_NAMES_SHORT[start.getMonth()]} ${start.getDate()} – ${MONTH_NAMES_SHORT[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
  }, [weekDays]);

  const navTitle = viewMode === 'month'
    ? `${MONTH_NAMES[month]} ${year}`
    : viewMode === 'week'
    ? weekRangeLabel
    : `${MONTH_NAMES[TODAY_MONTH]} ${TODAY_DAY}, ${TODAY_YEAR}`;

  const handlePrev = viewMode === 'week' ? handlePrevWeek : handlePrevMonth;
  const handleNext = viewMode === 'week' ? handleNextWeek : handleNextMonth;

  const todayKey = toDateKey(TODAY_YEAR, TODAY_MONTH, TODAY_DAY);
  const todaySessions = sessionsByDate.get(todayKey) ?? [];

  // Native split for the simple list view.
  const nowIsoLocal = useMemo(() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}T${hh}:${min}`;
  }, []);
  const { upcoming: nativeUpcoming, past: nativePast } = useMemo(
    () => splitUpcomingPast(allEvents, nowIsoLocal),
    [allEvents, nowIsoLocal],
  );

  // ── Loading / error guards ────────────────────────────────────────────────────

  if (sessionsQuery.isLoading) {
    return (
      <AppShell role="member" activeKey="appointments" userBlock={shellUserBlock}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <PageWrap style={styles.pageWrap}>
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="rows" rows={3} />
        </PageWrap>
      </AppShell>
    );
  }

  if (sessionsQuery.error) {
    return (
      <AppShell role="member" activeKey="appointments" userBlock={shellUserBlock}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <ErrorState
          message="Could not load calendar data. Please try again."
          onRetry={() => void sessionsQuery.refetch()}
        />
      </AppShell>
    );
  }

  // ── Header right slot — Week/Day/Month toggle ─────────────────────────────────

  const headerRight = (
    <View style={mainStyles.headerRight}>
      {assignedChw && (
        <TouchableOpacity
          style={mainStyles.scheduleBtn}
          onPress={() => setIsScheduleOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Schedule a session with ${assignedChw.name}`}
        >
          <CalendarPlus size={16} color="#FFFFFF" />
          <Text style={mainStyles.scheduleBtnText}>Schedule Session</Text>
        </TouchableOpacity>
      )}
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
    </View>
  );

  // ── Calendar card content (web grids) ─────────────────────────────────────────

  const calendarContent = (
    <View style={mainStyles.calendarOuter}>
      {/* Week/Month nav bar — hidden in day view (day is pinned to today, no navigation needed) */}
      {viewMode !== 'day' && (
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
      )}

      {/* Grid */}
      {viewMode === 'week' ? (
        <WeekViewGrid
          weekDays={weekDays}
          sessionsByDate={sessionsByDate}
          today={{ year: TODAY_YEAR, month: TODAY_MONTH, day: TODAY_DAY }}
          now={nowRef}
          onSessionPress={handleSessionPress}
          availabilityWindows={chwWindows}
        />
      ) : viewMode === 'day' ? (
        <DayViewGrid
          date={new Date(TODAY_YEAR, TODAY_MONTH, TODAY_DAY)}
          sessions={todaySessions}
          now={nowRef}
          onSessionPress={handleSessionPress}
          availabilityWindows={chwWindows}
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
                      accessibilityLabel={`Session with ${chwDisplayName(session.chwName)}`}
                    >
                      <View style={mainStyles.monthSessionLeftBar} />
                      <View style={mainStyles.monthSessionBody}>
                        <Text style={mainStyles.monthSessionTime} numberOfLines={1}>
                          {formatTimeRange(session.scheduledAt, session.scheduledEndAt)}
                        </Text>
                        <Text style={mainStyles.monthSessionMember} numberOfLines={1}>
                          {chwDisplayName(session.chwName)}
                        </Text>
                        <View style={mainStyles.monthSessionMeta}>
                          <SessionModeIcon mode={session.mode} size={11} color={tokens.emerald700} />
                          <Text style={mainStyles.monthSessionMode}>
                            {verticalLabel(session.vertical) || sessionModeLabel(session.mode)}
                          </Text>
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

  // ── Web layout ────────────────────────────────────────────────────────────────

  if (Platform.OS === 'web') {
    return (
      <AppShell role="member" activeKey="appointments" userBlock={shellUserBlock}>
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

        {/* Read-only session details modal */}
        <SessionDetailsModal
          session={detailSession}
          now={nowRef}
          visible={isDetailModalOpen}
          onClose={() => setIsDetailModalOpen(false)}
          onEdit={handleEditSession}
        />
        {assignedChw && (
          <MemberScheduleModal
            visible={isScheduleOpen}
            onClose={handleScheduleClose}
            chwId={assignedChw.id}
            chwName={assignedChw.name}
            replaceSessionId={rescheduleSession?.id}
          />
        )}
      </AppShell>
    );
  }

  // ── Native layout — simple upcoming/past list ─────────────────────────────────

  return (
    <AppShell role="member" activeKey="appointments" userBlock={shellUserBlock}>
      <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={refresh.control}
      >
        <PageWrap style={styles.pageWrap}>
          <PageHeader
            title="Calendar"
            subtitle="Your schedule and appointments"
          />

          {allEvents.length === 0 ? (
            <Card style={styles.emptyStateCard}>
              <CalendarDays size={36} color={tokens.textMuted} />
              <Text style={styles.emptyStateTitle}>No sessions yet</Text>
              <Text style={styles.emptyStateSub}>
                Connect with a Community Health Worker to schedule your first session.
              </Text>
              <TouchableOpacity
                style={styles.findCHWBtn}
                onPress={handleFindCHW}
                accessibilityRole="button"
                accessibilityLabel="Find a CHW"
              >
                <Users size={14} color={tokens.cardBg} />
                <Text style={styles.findCHWBtnText}>Find a CHW</Text>
              </TouchableOpacity>
            </Card>
          ) : (
            <>
              {nativeUpcoming.length > 0 && (
                <View style={styles.listSection}>
                  <SectionHeader title="Upcoming" marginBottom={spacing.md - 2} />
                  {nativeUpcoming.map((event) => (
                    <MemberListCard
                      key={event.id}
                      event={event}
                      now={nowRef}
                      onPress={handleEventPress}
                    />
                  ))}
                </View>
              )}

              {nativePast.length > 0 && (
                <View style={styles.listSection}>
                  <SectionHeader title="Past" marginBottom={spacing.md - 2} />
                  {nativePast.map((event) => (
                    <MemberListCard
                      key={event.id}
                      event={event}
                      now={nowRef}
                      onPress={handleEventPress}
                    />
                  ))}
                </View>
              )}
            </>
          )}

          <View style={{ height: 32 }} />
        </PageWrap>
      </ScrollView>

      {/* Session details modal (with Edit/Remove for upcoming sessions) */}
      <SessionDetailsModal
        session={detailSession}
        now={nowRef}
        visible={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        onEdit={handleEditSession}
      />
      {assignedChw && (
        <MemberScheduleModal
          visible={isScheduleOpen}
          onClose={handleScheduleClose}
          chwId={assignedChw.id}
          chwName={assignedChw.name}
          replaceSessionId={rescheduleSession?.id}
        />
      )}
    </AppShell>
  );
}

// ─── Member schedule modal ──────────────────────────────────────────────────

interface MemberScheduleModalProps {
  visible: boolean;
  onClose: () => void;
  chwId: string;
  chwName: string;
  /** When set (Edit flow), the old session is cancelled after the re-book. */
  replaceSessionId?: string;
}

/**
 * Member-side "Schedule a session" — mirrors the CHW ScheduleSessionModal but
 * books with the member's own CHW (no member picker). The booking is created as
 * pending (a request the CHW confirms) via POST /sessions/schedule with chw_id.
 * In the Edit/reschedule flow (`replaceSessionId`), the old session is cancelled
 * only after the new one books successfully — so nothing is lost if it fails.
 */
function MemberScheduleModal({
  visible,
  onClose,
  chwId,
  chwName,
  replaceSessionId,
}: MemberScheduleModalProps): React.JSX.Element {
  const { mutateAsync, isPending } = useScheduleSession();
  const cancelOldSession = useCancelSession();
  const [mode, setMode] = useState<'in_person' | 'virtual' | 'phone'>('in_person');
  const [dateInput, setDateInput] = useState<string>(() => {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return `${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')}/${t.getFullYear()}`;
  });
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // MM/DD/YYYY → YYYY-MM-DD for the slots API. null when the date is malformed.
  const isoDate = useMemo(() => {
    const [mm, dd, yyyy] = dateInput.split('/').map(Number);
    if (!mm || !dd || !yyyy || isNaN(mm) || isNaN(dd) || isNaN(yyyy)) return null;
    return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }, [dateInput]);

  // Only the CHW's open slots are offered — unavailable/booked times never appear.
  const slotsQuery = useChwAvailableSlots(chwId, isoDate ?? '', visible && !!isoDate);
  const slots = slotsQuery.data?.slots ?? [];

  // Clear the picked slot whenever the date changes (its slots no longer apply).
  useEffect(() => {
    setSelectedSlot(null);
  }, [isoDate]);

  const handleSubmit = useCallback(async () => {
    setError(null);
    if (!selectedSlot) {
      setError('Pick an available time.');
      return;
    }
    const scheduledEndAt = new Date(
      new Date(selectedSlot).getTime() + 30 * 60 * 1000,
    ).toISOString();
    try {
      await mutateAsync({
        chwId,
        scheduledAt: selectedSlot,
        scheduledEndAt,
        mode,
        schedulingStatus: 'pending',
      });
      // Reschedule: only after the new booking succeeds do we cancel the old
      // slot, so a failure never leaves the member with no session.
      if (replaceSessionId) {
        try {
          await cancelOldSession.mutateAsync(replaceSessionId);
        } catch {
          // Non-fatal — the new session booked; the stale one can be removed
          // manually. cancelOldSession surfaces its own error alert.
        }
      }
      onClose();
    } catch {
      // useScheduleSession surfaces the error via its onError alert.
    }
  }, [selectedSlot, mode, chwId, mutateAsync, replaceSessionId, cancelOldSession, onClose]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={scheduleStyles.overlay}>
        <View style={scheduleStyles.card}>
          <Text style={scheduleStyles.title}>
            {replaceSessionId ? 'Reschedule session' : 'Schedule a session'}
          </Text>
          <Text style={scheduleStyles.sub}>with {chwName}</Text>

          <Text style={scheduleStyles.label}>Date</Text>
          <TextInput
            style={scheduleStyles.input}
            value={dateInput}
            onChangeText={setDateInput}
            placeholder="MM/DD/YYYY"
            placeholderTextColor={tokens.textMuted}
          />

          <Text style={scheduleStyles.label}>Available times</Text>
          {slotsQuery.isLoading ? (
            <Text style={scheduleStyles.note}>Loading open times…</Text>
          ) : slots.length === 0 ? (
            <Text style={scheduleStyles.note}>
              No open times on this day. Try another date.
            </Text>
          ) : (
            <View style={scheduleStyles.slotGrid}>
              {slots.map((iso) => {
                const label = new Date(iso).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                });
                const active = selectedSlot === iso;
                return (
                  <TouchableOpacity
                    key={iso}
                    style={[scheduleStyles.slotPill, active && scheduleStyles.slotPillActive]}
                    onPress={() => setSelectedSlot(iso)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`${label}${active ? ', selected' : ''}`}
                  >
                    <Text style={[scheduleStyles.slotText, active && scheduleStyles.slotTextActive]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          <Text style={scheduleStyles.label}>Type</Text>
          <View style={scheduleStyles.segment}>
            {(['in_person', 'virtual', 'phone'] as const).map((m) => (
              <TouchableOpacity
                key={m}
                style={[scheduleStyles.segBtn, mode === m && scheduleStyles.segBtnActive]}
                onPress={() => setMode(m)}
                accessibilityRole="button"
                accessibilityState={{ selected: mode === m }}
              >
                <Text style={[scheduleStyles.segText, mode === m && scheduleStyles.segTextActive]}>
                  {m === 'in_person' ? 'In person' : m === 'virtual' ? 'Virtual' : 'Phone'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {error && <Text style={scheduleStyles.error}>{error}</Text>}
          <Text style={scheduleStyles.note}>Your CHW will confirm this request.</Text>

          <View style={scheduleStyles.actions}>
            <TouchableOpacity
              style={scheduleStyles.cancelBtn}
              onPress={onClose}
              disabled={isPending}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={scheduleStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[scheduleStyles.submitBtn, (isPending || !selectedSlot) && { opacity: 0.6 }]}
              onPress={() => void handleSubmit()}
              disabled={isPending || !selectedSlot}
              accessibilityRole="button"
              accessibilityLabel="Request session"
            >
              <Text style={scheduleStyles.submitText}>
                {isPending ? 'Scheduling…' : 'Request session'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const scheduleStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#FFFFFF',
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: tokens.textPrimary,
  },
  sub: {
    fontSize: 13,
    color: tokens.textSecondary,
    marginBottom: spacing.sm,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: tokens.textSecondary,
    marginTop: spacing.sm,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 10,
    fontSize: 14,
    color: tokens.textPrimary,
    backgroundColor: '#FFFFFF',
  },
  slotGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    maxHeight: 168,
  },
  slotPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  slotPillActive: {
    backgroundColor: tokens.primary,
    borderColor: tokens.primary,
  },
  slotText: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textSecondary,
  },
  slotTextActive: {
    color: '#FFFFFF',
  },
  segment: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  segBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'center',
  },
  segBtnActive: {
    backgroundColor: tokens.primary,
    borderColor: tokens.primary,
  },
  segText: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textSecondary,
  },
  segTextActive: {
    color: '#FFFFFF',
  },
  error: {
    fontSize: 12,
    color: '#b91c1c',
    marginTop: spacing.sm,
  },
  note: {
    fontSize: 12,
    color: tokens.textMuted,
    marginTop: spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.textSecondary,
  },
  submitBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: tokens.primary,
    alignItems: 'center',
  },
  submitText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});

// ─── Web styles ───────────────────────────────────────────────────────────────

const webStyles = StyleSheet.create({
  root: {
    flex: 1,
  },
  calendarCard: {
    marginBottom: spacing.xxl,
    overflow: 'hidden',
    padding: 0,
  },
});

// ─── Main / shared styles ─────────────────────────────────────────────────────

const mainStyles = StyleSheet.create({
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  scheduleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: tokens.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    borderRadius: radius.pill,
  },
  scheduleBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
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
  calendarOuter: {
    overflow: 'hidden',
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

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  pageWrap: {
    width: '100%',
    alignSelf: 'stretch',
    paddingHorizontal: 32,
    paddingTop: 24,
    paddingBottom: 32,
  },

  // ── Empty state (native, no sessions at all) ────────────────────────────────
  emptyStateCard: {
    backgroundColor: tokens.cardBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    padding: 32,
    alignItems: 'center',
    gap: 10,
    marginBottom: 20,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  emptyStateTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: '#1E3320',
    textAlign: 'center',
  },
  emptyStateSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7A6B',
    textAlign: 'center',
    lineHeight: 20,
  },

  // ── Find a CHW CTA button ───────────────────────────────────────────────────
  findCHWBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: tokens.primary,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 4,
  },
  findCHWBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#FFFFFF',
  },

  // ── Native list sections ────────────────────────────────────────────────────
  listSection: {
    marginBottom: 20,
  },
});

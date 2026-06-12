/**
 * MemberCalendarScreen — Week-view calendar matching CHWCalendarScreen layout.
 *
 * Features:
 *  - Week-view grid: Mon–Sun columns × hourly rows (7 AM–7 PM) as the default on web
 *  - Month nav header: prev/next chevrons + "May 11–17, 2026" week label + Today button
 *  - Session chips: vertical color-coded, showing topic + CHW name + start time
 *  - Right rail (web only): "Upcoming sessions" — next 5 scheduled, with vertical pill
 *  - Native: simpler upcoming/past list (native week-view is impractical at narrow widths)
 *  - Empty state: friendly message + "Find a CHW" CTA → FindCHW tab
 *
 * Data: useSessions() — same hook as CHW side; member sees only their own sessions.
 * Shell: AppShell role="member" activeKey="appointments"
 *
 * WeekViewGrid copied inline from CHWCalendarScreen.WeekViewGrid —
 * the function is not tightly coupled to CHW-specific fields (only CalendarEvent),
 * so a verbatim copy avoids a shared-component abstraction before the types stabilize.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Users,
} from 'lucide-react-native';
import { useNavigation, type NavigationProp } from '@react-navigation/native';

import { colors as tokens, numerals, spacing, radius } from '../../theme/tokens';
import {
  verticalLabels,
  type CalendarEvent,
  type Vertical,
} from '../../data/mock';
import { useSessions } from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { VERTICAL_COLOR } from '../../lib/verticals';
import { AppShell, PageHeader, Card, RightRail, SectionHeader, PageWrap } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import type { MemberTabParamList } from '../../navigation/MemberTabNavigator';

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_LABELS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_LABELS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Hours displayed in week-view grid: 7 AM – 7 PM inclusive = 13 slots. */
const WEEK_VIEW_HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

/** Vertical → hex color map, extended with goal_milestone. */
const VERTICAL_COLORS: Record<Vertical | 'goal_milestone', string> = {
  ...(VERTICAL_COLOR as Record<Vertical, string>),
  goal_milestone: tokens.emerald500,
};

const now = new Date();
const TODAY_YEAR = now.getFullYear();
const TODAY_MONTH = now.getMonth();
const TODAY_DAY = now.getDate();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the 7-day Date[] for the ISO week (Mon–Sun) containing the given anchor date. */
function getWeekDays(anchor: Date): Date[] {
  const day = anchor.getDay(); // 0 = Sun
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - day + (day === 0 ? -6 : 1));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

/** Formats a Date to YYYY-MM-DD string. */
function dateToKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Groups CalendarEvent[] by their `date` field. */
function groupByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const bucket = map.get(event.date) ?? [];
    map.set(event.date, [...bucket, event]);
  }
  return map;
}

/**
 * Derives CalendarEvent records from the member's sessions array.
 * Title shows "Session with <CHW first name>" from the member's perspective.
 */
function deriveSessionEvents(
  sessions: { id: string; scheduledAt: string; vertical: string; chwName?: string; memberName?: string; status: string }[],
): CalendarEvent[] {
  return sessions.map((session) => {
    const dt = new Date(session.scheduledAt);
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    const date = `${dt.getUTCFullYear()}-${mm}-${dd}`;
    const hh = String(dt.getUTCHours()).padStart(2, '0');
    const min = String(dt.getUTCMinutes()).padStart(2, '0');
    const endHH = String(dt.getUTCHours() + 1).padStart(2, '0');
    const chwFirst = (session.chwName ?? 'CHW').split(' ')[0] ?? 'CHW';

    return {
      id: `member-sess-${session.id}`,
      title: `Session with ${chwFirst}`,
      date,
      startTime: `${hh}:${min}`,
      endTime: `${endHH}:${min}`,
      vertical: session.vertical as Vertical | undefined,
      type: 'session' as const,
      chwName: session.chwName,
      memberName: session.memberName,
    };
  });
}

/** Resolves the hex color for a calendar event based on its vertical. */
function eventColor(event: CalendarEvent): string {
  if (event.vertical) return VERTICAL_COLORS[event.vertical] ?? tokens.emerald500;
  return VERTICAL_COLORS.goal_milestone;
}

/**
 * Formats HH:MM 24h → "2:00 PM".
 */
function formatTimeFull(time: string): string {
  const [hourStr, minuteStr] = time.split(':');
  const hour = parseInt(hourStr ?? '0', 10);
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

// ─── WeekViewGrid — web-focused ───────────────────────────────────────────────
// Mirrors CHWCalendarScreen.WeekViewGrid — copied inline rather than extracted
// to a shared component because CalendarEvent types are still stabilizing and
// an abstraction layer adds premature surface area.

interface WeekViewGridProps {
  weekDays: Date[];
  eventsByDate: Map<string, CalendarEvent[]>;
  today: { year: number; month: number; day: number };
  /** Called when the user taps a slot — no-op until scheduling is wired. */
  onSlotPress: (date: Date, hour: number) => void;
}

/**
 * 7-column × hourly-row week-view grid.
 * Each cell is 56px tall; today's column carries a pale tint; sessions render
 * as color-coded chips inside their hour slot.
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
                {DAY_LABELS_SHORT[date.getDay()]}
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
            <Text style={[weekStyles.timeLabel, numerals.tabular]}>{formatHourLabel(hour)}</Text>
          </View>
          {/* Day columns */}
          {weekDays.map((date) => {
            const key = dateToKey(date);
            const dayEvents = (eventsByDate.get(key) ?? []).filter((e) => {
              const eventHour = parseInt(e.startTime.split(':')[0] ?? '0', 10);
              return eventHour === hour;
            });
            const isToday =
              date.getFullYear() === today.year &&
              date.getMonth() === today.month &&
              date.getDate() === today.day;

            return (
              <TouchableOpacity
                key={`${key}-${hour}`}
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
                      <Text
                        style={[weekStyles.eventChipTitle, { color: barColor }]}
                        numberOfLines={1}
                      >
                        {event.title}
                      </Text>
                      {event.chwName ? (
                        <Text
                          style={[weekStyles.eventChipMeta, { color: barColor }]}
                          numberOfLines={1}
                        >
                          {event.chwName}
                        </Text>
                      ) : null}
                      <Text style={[weekStyles.eventChipMeta, { color: barColor }, numerals.tabular]}>
                        {formatTimeFull(event.startTime)}
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
    borderBottomColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
  },
  timeGutter: {
    width: 64,
    paddingRight: spacing.sm,
    alignItems: 'flex-end',
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: tokens.cardBorder,
  },
  timeLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: tokens.textMuted,
    paddingTop: 2,
  },
  dayHeader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRightWidth: 1,
    borderRightColor: tokens.cardBorder,
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
    color: tokens.textSecondary,
  },
  dayHeaderLabelToday: {
    color: tokens.primary,
  },
  dayHeaderDate: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: tokens.textPrimary,
  },
  dayHeaderDateToday: {
    color: tokens.cardBg,
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
    borderBottomColor: tokens.cardBorder,
  },
  hourCell: {
    flex: 1,
    borderRightWidth: 1,
    borderRightColor: tokens.cardBorder,
    padding: 2,
    gap: 2,
  },
  hourCellToday: {
    backgroundColor: tokens.primary + '05',
  },
  eventChip: {
    borderLeftWidth: 2,
    borderRadius: radius.sm / 2,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    gap: 1,
  },
  eventChipTitle: {
    fontSize: 10,
    fontFamily: 'PlusJakartaSans_600SemiBold',
  },
  eventChipMeta: {
    fontSize: 9,
    fontFamily: 'PlusJakartaSans_400Regular',
    opacity: 0.85,
  },
});

// ─── EventDetailCard — native list card ──────────────────────────────────────

interface EventDetailCardProps {
  event: CalendarEvent;
}

/**
 * Session detail card used in the native list view and the week-view selected
 * slot panel. Matches the visual treatment from the existing MemberCalendarScreen.
 */
function EventDetailCard({ event }: EventDetailCardProps): React.JSX.Element {
  const barColor = eventColor(event);
  const isSession = event.type === 'session';

  return (
    <View style={cardStyles.container}>
      <View style={[cardStyles.colorStrip, { backgroundColor: barColor }]} />
      <View style={cardStyles.content}>
        <View style={cardStyles.titleRow}>
          <Text style={cardStyles.title} numberOfLines={2}>{event.title}</Text>
          {event.vertical ? (
            <View style={[cardStyles.badge, { backgroundColor: `${barColor}20` }]}>
              <Text style={[cardStyles.badgeText, { color: barColor }]}>
                {verticalLabels[event.vertical]}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={cardStyles.metaRow}>
          <Clock color={tokens.textMuted} size={12} />
          <Text style={[cardStyles.metaText, numerals.tabular]}>
            {formatTimeFull(event.startTime)}
            {event.endTime !== event.startTime ? ` – ${formatTimeFull(event.endTime)}` : ''}
          </Text>
        </View>

        {isSession && event.chwName ? (
          <View style={cardStyles.metaRow}>
            <MapPin color={tokens.textMuted} size={12} />
            <Text style={cardStyles.metaText}>With {event.chwName}</Text>
          </View>
        ) : null}

        {!isSession ? (
          <View style={cardStyles.metaRow}>
            <CalendarDays color={tokens.textMuted} size={12} />
            <Text style={cardStyles.metaText}>Goal milestone</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const cardStyles = StyleSheet.create({
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
  },
  content: {
    flex: 1,
    padding: spacing.md,
    gap: spacing.xs,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: tokens.textPrimary,
    flex: 1,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
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

// ─── Web right rail — "Upcoming Sessions" ─────────────────────────────────────

interface MemberRightRailProps {
  upcomingEvents: CalendarEvent[];
  onFindCHW: () => void;
}

/**
 * Web-only right rail: shows the next 5 scheduled sessions with vertical pill,
 * scheduled time, and the CHW name. Falls back to a "Find a CHW" CTA when empty.
 */
function MemberRightRail({ upcomingEvents, onFindCHW }: MemberRightRailProps): React.JSX.Element {
  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Card style={railStyles.card}>
        <SectionHeader title="Upcoming Sessions" marginBottom={spacing.md} />
        {upcomingEvents.length === 0 ? (
          <View style={railStyles.emptyWrap}>
            <CalendarDays size={24} color={tokens.textMuted} />
            <Text style={railStyles.emptyText}>No upcoming sessions.</Text>
            <TouchableOpacity
              style={railStyles.ctaBtn}
              onPress={onFindCHW}
              accessibilityRole="button"
              accessibilityLabel="Find a CHW"
            >
              <Users size={13} color="#FFFFFF" />
              <Text style={railStyles.ctaBtnText}>Find a CHW</Text>
            </TouchableOpacity>
          </View>
        ) : (
          upcomingEvents.map((event) => {
            const barColor = eventColor(event);
            return (
              <View key={event.id} style={railStyles.sessionRow}>
                <View style={[railStyles.verticalPill, { backgroundColor: barColor }]} />
                <View style={railStyles.sessionInfo}>
                  <Text style={railStyles.sessionTitle} numberOfLines={1}>
                    {event.title}
                  </Text>
                  <Text style={[railStyles.sessionTime, numerals.tabular]}>
                    {event.date} · {formatTimeFull(event.startTime)}
                  </Text>
                  {event.chwName ? (
                    <Text style={railStyles.sessionChw} numberOfLines={1}>
                      {event.chwName}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })
        )}
      </Card>
    </ScrollView>
  );
}

const railStyles = StyleSheet.create({
  card: {
    padding: spacing.xl,
    marginBottom: spacing.lg,
    gap: spacing.md,
  },
  emptyWrap: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  emptyText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: tokens.textMuted,
    textAlign: 'center',
  },
  ctaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    backgroundColor: tokens.primary,
    borderRadius: radius.sm + 2,
    paddingHorizontal: 14,
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
  ctaBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: tokens.cardBg,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: spacing.xs + 2,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
  },
  verticalPill: {
    width: 4,
    borderRadius: 2,
    minHeight: 40,
    flexShrink: 0,
    marginTop: 2,
  },
  sessionInfo: {
    flex: 1,
    gap: 2,
  },
  sessionTitle: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: tokens.textPrimary,
  },
  sessionTime: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.textSecondary,
  },
  sessionChw: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.textSecondary,
  },
});

// ─── Native list view helpers ──────────────────────────────────────────────────

/**
 * Groups a flat CalendarEvent[] into upcoming (future) and past buckets
 * relative to the current moment.
 */
function splitUpcomingPast(
  events: CalendarEvent[],
  nowIso: string,
): { upcoming: CalendarEvent[]; past: CalendarEvent[] } {
  const upcoming: CalendarEvent[] = [];
  const past: CalendarEvent[] = [];
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

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * Member calendar screen — week-view grid on web, upcoming/past list on native.
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

  // Week anchor: tracks which Mon–Sun week is displayed. Defaults to today's week.
  const [weekAnchor, setWeekAnchor] = useState(
    () => new Date(TODAY_YEAR, TODAY_MONTH, TODAY_DAY),
  );
  const weekDays = useMemo(() => getWeekDays(weekAnchor), [weekAnchor]);

  const sessionsQuery = useSessions();
  const refresh = useRefreshControl([sessionsQuery.refetch]);
  const liveSessions = sessionsQuery.data ?? [];

  const allEvents = useMemo<CalendarEvent[]>(
    () => deriveSessionEvents(liveSessions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionsQuery.data],
  );

  const eventsByDate = useMemo(() => groupByDate(allEvents), [allEvents]);

  // Week nav — prev/next move by 7 days; Today snaps back to current week.
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

  const handleJumpToToday = useCallback(() => {
    setWeekAnchor(new Date(TODAY_YEAR, TODAY_MONTH, TODAY_DAY));
  }, []);

  const handleSlotPress = useCallback((_date: Date, _hour: number) => {
    // TODO(nav): navigate to request scheduling when route is wired.
  }, []);

  const handleFindCHW = useCallback(() => {
    // Navigate into the FindCHW tab's nested stack at the explicit FindList
    // screen — MyCHWScreen (FindMain) auto-renders the existing-CHW profile
    // when the member already has sessions, so 'FindCHW' alone dead-ends
    // there. FindList always shows MemberFindScreen.
    navigation.navigate('FindCHW', { screen: 'FindList' });
  }, [navigation]);

  // ── Derived data ─────────────────────────────────────────────────────────────

  // "Upcoming" = status='scheduled' and scheduledAt is in the future, next 5.
  const nowTimestamp = now.getTime();
  const upcomingEvents = useMemo<CalendarEvent[]>(() => {
    return liveSessions
      .filter(
        (s) =>
          s.status === 'scheduled' &&
          new Date(s.scheduledAt).getTime() > nowTimestamp,
      )
      .sort(
        (a, b) =>
          new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime(),
      )
      .slice(0, 5)
      .map((s) => {
        const dt = new Date(s.scheduledAt);
        const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(dt.getUTCDate()).padStart(2, '0');
        const date = `${dt.getUTCFullYear()}-${mm}-${dd}`;
        const hh = String(dt.getUTCHours()).padStart(2, '0');
        const min = String(dt.getUTCMinutes()).padStart(2, '0');
        const endHH = String(dt.getUTCHours() + 1).padStart(2, '0');
        const chwFirst = (s.chwName ?? 'CHW').split(' ')[0] ?? 'CHW';
        return {
          id: `member-sess-${s.id}`,
          title: `Session with ${chwFirst}`,
          date,
          startTime: `${hh}:${min}`,
          endTime: `${endHH}:${min}`,
          vertical: s.vertical as Vertical | undefined,
          type: 'session' as const,
          chwName: s.chwName,
          memberName: s.memberName,
        };
      });
  }, [liveSessions, nowTimestamp]);

  // Week label: "May 11 – 17, 2026" or cross-month "Apr 28 – May 4, 2026"
  const weekLabel = useMemo(() => {
    const start = weekDays[0];
    const end = weekDays[6];
    if (start.getMonth() === end.getMonth()) {
      return `${MONTH_NAMES[start.getMonth()]} ${start.getDate()} – ${end.getDate()}, ${end.getFullYear()}`;
    }
    return `${MONTH_NAMES[start.getMonth()]} ${start.getDate()} – ${MONTH_NAMES[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
  }, [weekDays]);

  // Is the displayed week the current week?
  const todayWeekDays = useMemo(() => getWeekDays(new Date(TODAY_YEAR, TODAY_MONTH, TODAY_DAY)), []);
  const isCurrentWeek =
    dateToKey(weekDays[0]) === dateToKey(todayWeekDays[0]);

  // Empty-week detection: no events anywhere in the displayed week.
  const weekEvents = useMemo(
    () => weekDays.flatMap((d) => eventsByDate.get(dateToKey(d)) ?? []),
    [weekDays, eventsByDate],
  );
  const weekIsEmpty = weekEvents.length === 0;

  // Native split for the simple list view.
  const nowIsoLocal = (() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}T${hh}:${min}`;
  })();
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

  // ── Nav header (shared) ───────────────────────────────────────────────────────

  const navHeader = (
    <View style={styles.monthNav}>
      <TouchableOpacity
        style={styles.navButton}
        onPress={handlePrevWeek}
        accessibilityRole="button"
        accessibilityLabel="Previous week"
      >
        <ChevronLeft size={20} color="#FFFFFF" />
      </TouchableOpacity>

      <View style={styles.navCenter}>
        <Text style={styles.weekLabel}>{weekLabel}</Text>
        {!isCurrentWeek && (
          <TouchableOpacity
            style={styles.todayBtn}
            onPress={handleJumpToToday}
            accessibilityRole="button"
            accessibilityLabel="Jump to current week"
          >
            <Text style={styles.todayBtnText}>Today</Text>
          </TouchableOpacity>
        )}
      </View>

      <TouchableOpacity
        style={styles.navButton}
        onPress={handleNextWeek}
        accessibilityRole="button"
        accessibilityLabel="Next week"
      >
        <ChevronRight size={20} color="#FFFFFF" />
      </TouchableOpacity>
    </View>
  );

  // ── Web layout ────────────────────────────────────────────────────────────────

  if (Platform.OS === 'web') {
    return (
      <AppShell role="member" activeKey="appointments" userBlock={shellUserBlock}>
        <View style={webStyles.root}>
          {/* Main calendar column */}
          <View style={webStyles.mainCol}>
            <PageHeader
              title="Appointments"
              subtitle="Your upcoming sessions and milestones"
            />

            <Card style={webStyles.calendarCard}>
              <View style={styles.calendarOuter}>
                {navHeader}
                {weekIsEmpty ? (
                  <View style={styles.emptyWeekWrap}>
                    <CalendarDays size={32} color={tokens.textMuted} />
                    <Text style={styles.emptyWeekTitle}>No sessions this week</Text>
                    <Text style={styles.emptyWeekSub}>
                      Schedule a session with your CHW to get started.
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
                  </View>
                ) : (
                  <WeekViewGrid
                    weekDays={weekDays}
                    eventsByDate={eventsByDate}
                    today={{ year: TODAY_YEAR, month: TODAY_MONTH, day: TODAY_DAY }}
                    onSlotPress={handleSlotPress}
                  />
                )}
              </View>
            </Card>
          </View>

          {/* Right rail — upcoming sessions */}
          <RightRail width={288} style={webStyles.rail}>
            <MemberRightRail
              upcomingEvents={upcomingEvents}
              onFindCHW={handleFindCHW}
            />
          </RightRail>
        </View>
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
            title="Appointments"
            subtitle="Your upcoming sessions and milestones."
          />

          {allEvents.length === 0 ? (
            /* Global empty state — Card replaces the inline emptyStateCard View */
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
              {/* Upcoming */}
              {nativeUpcoming.length > 0 && (
                <View style={styles.listSection}>
                  <SectionHeader title="Upcoming" marginBottom={spacing.md - 2} />
                  {nativeUpcoming.map((event) => (
                    <EventDetailCard key={event.id} event={event} />
                  ))}
                </View>
              )}

              {/* Past */}
              {nativePast.length > 0 && (
                <View style={styles.listSection}>
                  <SectionHeader title="Past" marginBottom={spacing.md - 2} />
                  {nativePast.map((event) => (
                    <EventDetailCard key={event.id} event={event} />
                  ))}
                </View>
              )}
            </>
          )}

          <View style={{ height: 32 }} />
        </PageWrap>
      </ScrollView>
    </AppShell>
  );
}

// ─── Web styles ───────────────────────────────────────────────────────────────

const webStyles = StyleSheet.create({
  root: {
    flex: 1,
    flexDirection: 'row',
    gap: 24,
    padding: 0,
    alignItems: 'flex-start',
  },
  mainCol: {
    flex: 1,
  },
  calendarCard: {
    marginBottom: 24,
    overflow: 'hidden',
    padding: 0,
  },
  rail: {
    paddingTop: 8,
  },
});

// ─── Shared styles ────────────────────────────────────────────────────────────

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
  calendarOuter: {
    overflow: 'hidden',
  },

  // ── Month nav header ────────────────────────────────────────────────────────
  monthNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 14,
    backgroundColor: tokens.primary,
    borderBottomWidth: 1,
    borderBottomColor: tokens.primary,
  },
  navButton: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  navCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    justifyContent: 'center',
  },
  weekLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 15,
    lineHeight: 22,
    color: '#FFFFFF',
  },
  todayBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  todayBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#FFFFFF',
  },

  // ── Empty week state ────────────────────────────────────────────────────────
  emptyWeekWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 56,
    paddingHorizontal: 32,
  },
  emptyWeekTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: '#1E3320',
    textAlign: 'center',
  },
  emptyWeekSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7A6B',
    textAlign: 'center',
    lineHeight: 20,
  },

  // ── Empty state (native, no sessions at all) ────────────────────────────────
  emptyStateCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
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
  sectionLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#6B7280',
    letterSpacing: 1,
    marginBottom: 10,
  },
});

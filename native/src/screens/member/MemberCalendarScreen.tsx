/**
 * MemberCalendarScreen — Monthly calendar for the member's sessions and goal milestones.
 *
 * Features:
 * - Compact monthly grid (shadcn-inspired: dense day cells, single-letter weekday header)
 * - Filled-pill "today" indicator + outlined "selected" indicator
 * - Up to 3 event dots stacked under the date number
 * - "Today" jump-back button when viewing a different month
 * - Tap a day to surface that day's event cards below
 * - Collapsible legend that only renders when the month has events
 * - Centered max-width wrapper so the card stays readable on desktop web
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  MapPin,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import {
  verticalLabels,
  type CalendarEvent,
  type Vertical,
} from '../../data/mock';
import { useSessions } from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Single-letter labels to keep the weekday row compact (matches shadcn calendar).
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const now = new Date();
const TODAY_YEAR = now.getFullYear();
const TODAY_MONTH = now.getMonth();
const TODAY_DAY = now.getDate();

const verticalColors: Record<Vertical | 'goal_milestone', string> = {
  housing: '#3B82F6',
  rehab: '#EF4444',
  food: '#F59E0B',
  mental_health: '#8B5CF6',
  healthcare: '#06B6D4',
  goal_milestone: colors.secondary,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns calendar cells for a month.
 * Leading nulls pad the first row to Sunday alignment.
 */
function getMonthDays(year: number, month: number): (number | null)[] {
  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = Array(firstDayOfWeek).fill(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function dateKey(year: number, month: number, day: number): string {
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function groupEventsByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const bucket = map.get(event.date) ?? [];
    map.set(event.date, [...bucket, event]);
  }
  return map;
}

function eventColor(event: CalendarEvent): string {
  if (event.vertical) return verticalColors[event.vertical];
  return verticalColors.goal_milestone;
}

function formatTimeFull(time: string): string {
  const [hourStr, minuteStr] = time.split(':');
  const hour = parseInt(hourStr ?? '0', 10);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${minuteStr} ${suffix}`;
}

function firstNameFromFull(fullName: string): string {
  return fullName.split(' ')[0] ?? fullName;
}

/**
 * Derives calendar events from live session data.
 *
 * Note: goal milestones are intentionally omitted here. A backend goals
 * endpoint doesn't exist yet; once it does, fetch via a `useMemberGoals`
 * query and append those events to `sessionEvents` in this function.
 */
function buildMemberEvents(
  liveSessions: { id: string; scheduledAt: string; vertical: string; chwName?: string; memberName?: string }[],
): CalendarEvent[] {
  const sessionEvents: CalendarEvent[] = liveSessions.map((session) => {
    const dt = new Date(session.scheduledAt);
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    const date = `${dt.getUTCFullYear()}-${mm}-${dd}`;
    const startHH = String(dt.getUTCHours()).padStart(2, '0');
    const startMin = String(dt.getUTCMinutes()).padStart(2, '0');
    const endHH = String(dt.getUTCHours() + 1).padStart(2, '0');

    return {
      id: `live-sess-${session.id}`,
      title: `Session with ${firstNameFromFull(session.chwName ?? 'CHW')}`,
      date,
      startTime: `${startHH}:${startMin}`,
      endTime: `${endHH}:${startMin}`,
      vertical: session.vertical as Vertical,
      type: 'session' as const,
      chwName: session.chwName,
      memberName: session.memberName,
    };
  });

  return sessionEvents;
}

// ─── Day cell ─────────────────────────────────────────────────────────────────

interface DayCellProps {
  day: number;
  events: CalendarEvent[];
  isToday: boolean;
  isSelected: boolean;
  onClick: () => void;
}

function DayCell({ day, events, isToday, isSelected, onClick }: DayCellProps): React.JSX.Element {
  // Up to 3 unique vertical colors as event dots.
  const uniqueColors = Array.from(new Set(events.map(eventColor))).slice(0, 3);

  return (
    <TouchableOpacity
      onPress={onClick}
      style={dayCellStyles.cell}
      accessibilityRole="button"
      accessibilityLabel={`${day}${events.length > 0 ? `, ${events.length} event${events.length !== 1 ? 's' : ''}` : ''}`}
      accessibilityState={{ selected: isSelected }}
    >
      <View
        style={[
          dayCellStyles.dateCircle,
          isSelected && !isToday && dayCellStyles.dateCircleSelected,
          isToday && dayCellStyles.dateCircleToday,
        ]}
      >
        <Text
          style={[
            dayCellStyles.dateText,
            isSelected && !isToday && dayCellStyles.dateTextSelected,
            isToday && dayCellStyles.dateTextToday,
          ]}
        >
          {day}
        </Text>
      </View>

      {/* Event dots — sit just under the date circle */}
      <View style={dayCellStyles.dotsRow}>
        {uniqueColors.map((c, i) => (
          <View
            key={i}
            style={[dayCellStyles.dot, { backgroundColor: c }]}
          />
        ))}
      </View>
    </TouchableOpacity>
  );
}

const DAY_CELL_HEIGHT = 52;
const DATE_CIRCLE_SIZE = 32;

const dayCellStyles = StyleSheet.create({
  cell: {
    flexBasis: `${100 / 7}%`,
    height: DAY_CELL_HEIGHT,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 4,
  },
  dateCircle: {
    width: DATE_CIRCLE_SIZE,
    height: DATE_CIRCLE_SIZE,
    borderRadius: DATE_CIRCLE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  dateCircleSelected: {
    borderColor: colors.primary,
    backgroundColor: 'transparent',
  },
  dateCircleToday: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  dateText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: colors.foreground,
  },
  dateTextSelected: {
    color: colors.primary,
    fontFamily: 'DMSans_700Bold',
  },
  dateTextToday: {
    color: '#FFFFFF',
    fontFamily: 'DMSans_700Bold',
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 3,
    marginTop: 4,
    minHeight: 5,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
});

// ─── Event detail card ────────────────────────────────────────────────────────

interface EventDetailCardProps {
  event: CalendarEvent;
}

function EventDetailCard({ event }: EventDetailCardProps): React.JSX.Element {
  const barColor = eventColor(event);
  const isSession = event.type === 'session';

  return (
    <View style={eventCardStyles.container}>
      <View style={[eventCardStyles.colorStrip, { backgroundColor: barColor }]} />
      <View style={eventCardStyles.content}>
        <View style={eventCardStyles.titleRow}>
          <Text style={eventCardStyles.title} numberOfLines={2}>{event.title}</Text>
          {event.vertical ? (
            <View style={[eventCardStyles.badge, { backgroundColor: `${barColor}20` }]}>
              <Text style={[eventCardStyles.badgeText, { color: barColor }]}>
                {verticalLabels[event.vertical]}
              </Text>
            </View>
          ) : null}
          {!event.vertical && event.type === 'goal_milestone' ? (
            <View style={[eventCardStyles.badge, { backgroundColor: `${colors.primary}15` }]}>
              <Text style={[eventCardStyles.badgeText, { color: colors.primary }]}>Milestone</Text>
            </View>
          ) : null}
        </View>

        <View style={eventCardStyles.metaRow}>
          <Clock color={colors.mutedForeground} size={12} />
          <Text style={eventCardStyles.metaText}>
            {formatTimeFull(event.startTime)}
            {event.endTime !== event.startTime ? ` – ${formatTimeFull(event.endTime)}` : ''}
          </Text>
        </View>

        {isSession && event.chwName ? (
          <View style={eventCardStyles.metaRow}>
            <MapPin color={colors.mutedForeground} size={12} />
            <Text style={eventCardStyles.metaText}>With {event.chwName}</Text>
          </View>
        ) : null}

        {!isSession ? (
          <View style={eventCardStyles.metaRow}>
            <CalendarDays color={colors.mutedForeground} size={12} />
            <Text style={eventCardStyles.metaText}>Goal milestone</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const eventCardStyles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    flexDirection: 'row',
    overflow: 'hidden',
    marginBottom: 10,
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
  colorStrip: {
    width: 4,
  },
  content: {
    flex: 1,
    padding: 12,
    gap: 4,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 4,
  },
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
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
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  metaText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
  },
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberCalendarScreen(): React.JSX.Element {
  // Default to the actual current month, not a hardcoded one.
  const [currentMonth, setCurrentMonth] = useState(
    () => new Date(TODAY_YEAR, TODAY_MONTH, 1),
  );
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);

  const sessionsQuery = useSessions();
  const refresh = useRefreshControl([sessionsQuery.refetch]);
  const liveSessions = sessionsQuery.data ?? [];

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const cells = getMonthDays(year, month);

  const memberEvents = useMemo<CalendarEvent[]>(
    () => buildMemberEvents(liveSessions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionsQuery.data],
  );
  const eventsByDate = useMemo(() => groupEventsByDate(memberEvents), [memberEvents]);

  const handlePrevMonth = useCallback(() => {
    setCurrentMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
    setSelectedDay(null);
  }, []);

  const handleNextMonth = useCallback(() => {
    setCurrentMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
    setSelectedDay(null);
  }, []);

  const handleJumpToToday = useCallback(() => {
    setCurrentMonth(new Date(TODAY_YEAR, TODAY_MONTH, 1));
    setSelectedDay(TODAY_DAY);
  }, []);

  const handleDayClick = useCallback((day: number) => {
    setSelectedDay((prev) => (prev === day ? null : day));
  }, []);

  const selectedDateKey = selectedDay !== null ? dateKey(year, month, selectedDay) : null;
  const selectedEvents = selectedDateKey ? (eventsByDate.get(selectedDateKey) ?? []) : [];

  const currentMonthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const eventsThisMonth = memberEvents.filter((e) => e.date.startsWith(currentMonthKey));
  const monthHasEvents = eventsThisMonth.length > 0;

  const isViewingTodayMonth = year === TODAY_YEAR && month === TODAY_MONTH;
  const isToday = (day: number) => isViewingTodayMonth && day === TODAY_DAY;

  if (sessionsQuery.isLoading) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <View style={styles.pageWrap}>
          <View style={{ padding: 16, paddingTop: 20 }}>
            <LoadingSkeleton variant="card" />
            <LoadingSkeleton variant="rows" rows={3} />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (sessionsQuery.error) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <View style={styles.pageWrap}>
          <ErrorState
            message="Could not load calendar data. Please try again."
            onRetry={() => void sessionsQuery.refetch()}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={refresh.control}
      >
        <View style={styles.pageWrap}>
          {/* Page header */}
          <View style={styles.pageHeader}>
            <Text style={styles.pageTitle}>My Calendar</Text>
            <Text style={styles.pageSub}>Your upcoming sessions and goal milestones.</Text>
          </View>

          {/* Calendar card */}
          <View style={styles.calendarCard}>
            {/* Month navigation */}
            <View style={styles.monthNav}>
              <TouchableOpacity
                onPress={handlePrevMonth}
                style={styles.navBtn}
                accessibilityRole="button"
                accessibilityLabel="Previous month"
                hitSlop={8}
              >
                <ChevronLeft color={colors.mutedForeground} size={18} />
              </TouchableOpacity>

              <Text style={styles.monthTitle}>
                {MONTH_NAMES[month]} {year}
              </Text>

              <View style={styles.navRightGroup}>
                {!isViewingTodayMonth && (
                  <TouchableOpacity
                    onPress={handleJumpToToday}
                    style={styles.todayBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Jump to today"
                    hitSlop={6}
                  >
                    <Text style={styles.todayBtnText}>Today</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={handleNextMonth}
                  style={styles.navBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Next month"
                  hitSlop={8}
                >
                  <ChevronRight color={colors.mutedForeground} size={18} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Day-of-week header */}
            <View style={styles.dayLabelRow}>
              {DAY_LABELS.map((label, idx) => (
                <Text key={`${label}-${idx}`} style={styles.dayLabel}>{label}</Text>
              ))}
            </View>

            {/* Calendar grid */}
            <View
              style={styles.grid}
              accessibilityRole="list"
              accessibilityLabel={`${MONTH_NAMES[month]} ${year} calendar`}
            >
              {cells.map((day, idx) => {
                if (day === null) {
                  return <View key={`empty-${idx}`} style={styles.emptyCell} />;
                }
                const key = dateKey(year, month, day);
                const events = eventsByDate.get(key) ?? [];

                return (
                  <DayCell
                    key={key}
                    day={day}
                    events={events}
                    isToday={isToday(day)}
                    isSelected={selectedDay === day}
                    onClick={() => handleDayClick(day)}
                  />
                );
              })}
            </View>
          </View>

          {/* Day detail panel */}
          {selectedDay !== null && (
            <View style={styles.detailSection}>
              <Text style={styles.sectionLabel}>
                {MONTH_NAMES[month].toUpperCase()} {selectedDay}
              </Text>
              {selectedEvents.length === 0 ? (
                <View style={styles.noEventsCard}>
                  <CalendarDays color={colors.border} size={28} />
                  <Text style={styles.noEventsText}>No events on this day</Text>
                </View>
              ) : (
                selectedEvents.map((event) => (
                  <EventDetailCard key={event.id} event={event} />
                ))
              )}
            </View>
          )}

          {/* This month's events fallback */}
          {selectedDay === null && monthHasEvents && (
            <View style={styles.detailSection}>
              <Text style={styles.sectionLabel}>YOUR EVENTS THIS MONTH</Text>
              {eventsThisMonth.map((event) => (
                <EventDetailCard key={event.id} event={event} />
              ))}
            </View>
          )}

          {/* Empty-month hint — only when nothing is selected and the month is empty */}
          {selectedDay === null && !monthHasEvents && (
            <View style={styles.emptyMonthCard}>
              <CalendarDays color={colors.mutedForeground} size={22} />
              <Text style={styles.emptyMonthText}>
                No events scheduled for {MONTH_NAMES[month]}.
              </Text>
            </View>
          )}

          {/* Collapsible legend — only render when the month has events to color-code */}
          {monthHasEvents && (
            <Pressable
              onPress={() => setLegendOpen((prev) => !prev)}
              style={styles.legendCard}
              accessibilityRole="button"
              accessibilityLabel={legendOpen ? 'Collapse legend' : 'Expand legend'}
              accessibilityState={{ expanded: legendOpen }}
            >
              <View style={styles.legendHeader}>
                <Text style={styles.legendTitle}>LEGEND</Text>
                {legendOpen
                  ? <ChevronUp color={colors.mutedForeground} size={16} />
                  : <ChevronDown color={colors.mutedForeground} size={16} />}
              </View>
              {legendOpen && (
                <View style={styles.legendGrid}>
                  {(Object.entries(verticalLabels) as [Vertical, string][]).map(([key, label]) => (
                    <View key={key} style={styles.legendRow}>
                      <View style={[styles.legendDot, { backgroundColor: verticalColors[key] }]} />
                      <Text style={styles.legendLabel}>{label}</Text>
                    </View>
                  ))}
                  <View style={styles.legendRow}>
                    <View style={[styles.legendDot, { backgroundColor: verticalColors.goal_milestone }]} />
                    <Text style={styles.legendLabel}>Milestone</Text>
                  </View>
                </View>
              )}
            </Pressable>
          )}

          <View style={{ height: 24 }} />
        </View>
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
  // Web stretches edge-to-edge by default; cap at 560px and center.
  pageWrap: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  pageHeader: {
    marginBottom: 16,
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

  // Calendar card
  calendarCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
    marginBottom: 16,
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
  monthNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  navBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#1E3320',
  },
  navRightGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  todayBtn: {
    paddingHorizontal: 10,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  todayBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: colors.primary,
  },
  dayLabelRow: {
    flexDirection: 'row',
  },
  dayLabel: {
    flexBasis: `${100 / 7}%`,
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#6B7280',
    textAlign: 'center',
    paddingVertical: 6,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  emptyCell: {
    flexBasis: `${100 / 7}%`,
    height: DAY_CELL_HEIGHT,
  },

  // Detail section
  detailSection: {
    marginBottom: 16,
  },
  sectionLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#6B7280',
    letterSpacing: 1,
    marginBottom: 10,
  },
  noEventsCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  noEventsText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
  },

  // Empty-month hint (no events anywhere this month)
  emptyMonthCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  emptyMonthText: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
  },

  // Legend
  legendCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 8,
  },
  legendHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  legendTitle: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#6B7280',
    letterSpacing: 1,
  },
  legendGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 12,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    width: '45%',
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
  },
});

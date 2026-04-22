/**
 * CHWCalendarScreen — Monthly calendar with session dots and day detail panel.
 *
 * Features:
 *  - 7-column monthly grid with prev/next navigation
 *  - Day cells with colored dot indicators for sessions/milestones
 *  - Tap a day to reveal events in a bottom section
 *  - Color-coded legend for verticals and milestones
 */

import React, { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Clock,
  MapPin,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import {
  verticalLabels,
  type CalendarEvent,
  type Vertical,
} from '../../data/mock';
import { useSessions, type SessionData } from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Maximum dot indicators per cell before "+N" overflow label. */
const MAX_DOTS_PER_CELL = 3;

const VERTICAL_COLORS: Record<Vertical | 'goal_milestone', string> = {
  housing: '#3B82F6',
  rehab: '#EF4444',
  food: '#F59E0B',
  mental_health: '#8B5CF6',
  healthcare: '#06B6D4',
  goal_milestone: colors.secondary,
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

/** Formats YYYY-MM-DD key from year/month/day. */
function toDateKey(year: number, month: number, day: number): string {
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
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
 *
 * Note: Previously merged with `mockCalendarEvents` fixture data. Now only
 * real sessions from the API are displayed. Goal milestones will reappear
 * when a backend goals endpoint exists.
 */
function deriveSessionEvents(sessions: SessionData[]): CalendarEvent[] {
  return sessions
    .map((session) => {
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

// ─── EventDetailCard sub-component ───────────────────────────────────────────

interface EventDetailCardProps {
  event: CalendarEvent;
}

function EventDetailCard({ event }: EventDetailCardProps): React.JSX.Element {
  const barColor = eventColor(event);
  const isSession = event.type === 'session';

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
          ) : event.type === 'goal_milestone' ? (
            <View style={[detailStyles.badge, { backgroundColor: colors.primary + '18' }]}>
              <Text style={[detailStyles.badgeText, { color: colors.primary }]}>Milestone</Text>
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
            {isSession ? (
              <MapPin size={12} color={colors.mutedForeground} />
            ) : (
              <CalendarDays size={12} color={colors.mutedForeground} />
            )}
            <Text style={detailStyles.metaText}>
              {event.memberName}
              {isSession && event.chwName ? ` · ${event.chwName}` : ''}
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
});

// ─── Main Component ───────────────────────────────────────────────────────────

const now = new Date();
const TODAY_YEAR = now.getFullYear();
const TODAY_MONTH = now.getMonth();
const TODAY_DAY = now.getDate();

/**
 * CHW Calendar screen — monthly grid + tapped-day event detail panel.
 */
export function CHWCalendarScreen(): React.JSX.Element {
  const { data: rawSessions, isLoading, error, refetch } = useSessions();
  const refresh = useRefreshControl([refetch]);

  // Default to April 2026 to show mock data
  const [currentDate, setCurrentDate] = useState(new Date(2026, 3, 1));
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const cells = useMemo(() => getMonthCells(year, month), [year, month]);

  const allSessions = rawSessions ?? [];

  const allEvents = useMemo<CalendarEvent[]>(() => {
    return deriveSessionEvents(allSessions);
  }, [allSessions]);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <Text style={styles.pageTitle}>Calendar</Text>
          <LoadingSkeleton variant="card" />
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ErrorState message="Failed to load calendar" onRetry={() => void refetch()} />
      </SafeAreaView>
    );
  }

  const eventsByDate = useMemo(() => groupByDate(allEvents), [allEvents]);

  const handlePrevMonth = useCallback(() => {
    setCurrentDate((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
    setSelectedDay(null);
  }, []);

  const handleNextMonth = useCallback(() => {
    setCurrentDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
    setSelectedDay(null);
  }, []);

  const handleDayPress = useCallback((day: number) => {
    setSelectedDay((prev) => (prev === day ? null : day));
  }, []);

  const selectedDateKey = selectedDay !== null ? toDateKey(year, month, selectedDay) : null;
  const selectedEvents = selectedDateKey ? (eventsByDate.get(selectedDateKey) ?? []) : [];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={refresh.control}
      >
        {/* Page header */}
        <Text style={styles.pageTitle}>Calendar</Text>

        {/* Calendar card */}
        <View style={styles.calendarCard}>
          {/* Month navigation */}
          <View style={styles.monthNav}>
            <TouchableOpacity
              style={styles.navButton}
              onPress={handlePrevMonth}
              accessibilityLabel="Previous month"
            >
              <ChevronLeft size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
            <Text style={styles.monthLabel}>
              {MONTH_NAMES[month]} {year}
            </Text>
            <TouchableOpacity
              style={styles.navButton}
              onPress={handleNextMonth}
              accessibilityLabel="Next month"
            >
              <ChevronRight size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

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
              const isToday =
                year === TODAY_YEAR && month === TODAY_MONTH && day === TODAY_DAY;
              const isSelected = selectedDay === day;
              const visibleEvents = dayEvents.slice(0, MAX_DOTS_PER_CELL);
              const overflowCount = dayEvents.length - visibleEvents.length;

              return (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.dayCell,
                    isSelected && styles.dayCellSelected,
                  ]}
                  onPress={() => handleDayPress(day)}
                  accessibilityRole="button"
                  accessibilityLabel={`${MONTH_NAMES[month]} ${day}${dayEvents.length > 0 ? `, ${dayEvents.length} event${dayEvents.length !== 1 ? 's' : ''}` : ''}`}
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

                  {/* Event dots */}
                  {dayEvents.length > 0 ? (
                    <View style={styles.dotsRow}>
                      {visibleEvents.map((event) => (
                        <View
                          key={event.id}
                          style={[
                            styles.dot,
                            { backgroundColor: eventColor(event) },
                          ]}
                        />
                      ))}
                      {overflowCount > 0 ? (
                        <Text style={styles.overflowLabel}>+{overflowCount}</Text>
                      ) : null}
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Selected day detail panel */}
        {selectedDay !== null ? (
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
          <Text style={styles.legendTitle}>Legend</Text>
          <View style={styles.legendGrid}>
            {(Object.entries(verticalLabels) as [Vertical, string][]).map(([key, label]) => (
              <View key={key} style={styles.legendItem}>
                <View
                  style={[styles.legendDot, { backgroundColor: VERTICAL_COLORS[key] }]}
                />
                <Text style={styles.legendText}>{label}</Text>
              </View>
            ))}
            <View style={styles.legendItem}>
              <View
                style={[styles.legendDot, { backgroundColor: VERTICAL_COLORS.goal_milestone }]}
              />
              <Text style={styles.legendText}>Milestone</Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const CELL_ASPECT = 52; // approximate cell height in px

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#F4F1ED',
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 20,
    paddingBottom: 48,
  },
  pageTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#1E3320',
    marginBottom: 20,
  },
  calendarCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    overflow: 'hidden',
    marginBottom: 20,
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
    paddingHorizontal: 12,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
  },
  navButton: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#F4F1ED',
  },
  monthLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
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
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCell: {
    width: '14.2857%', // 1/7
    minHeight: CELL_ASPECT,
    padding: 4,
    borderRightWidth: 1,
    borderRightColor: '#DDD6CC',
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
    alignItems: 'flex-start',
  },
  dayCellEmpty: {
    backgroundColor: '#F4F1ED',
  },
  dayCellSelected: {
    backgroundColor: '#3D5A3E15',
  },
  dayNumber: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  dayNumberToday: {
    backgroundColor: '#3D5A3E',
  },
  dayNumberText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#1E3320',
    lineHeight: 14,
  },
  dayNumberTextToday: {
    color: '#FFFFFF',
    fontFamily: 'PlusJakartaSans_600SemiBold',
  },
  dayNumberTextSelected: {
    color: '#3D5A3E',
    fontFamily: 'PlusJakartaSans_600SemiBold',
  },
  dotsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
    alignItems: 'center',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  overflowLabel: {
    fontSize: 8,
    color: colors.mutedForeground,
    lineHeight: 10,
  },
  detailSection: {
    marginBottom: 20,
  },
  detailHeading: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  emptyDay: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 28,
    alignItems: 'center',
    gap: 8,
  },
  emptyDayText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
  },
  legendCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
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
    color: '#6B7A6B',
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  legendGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    width: '45%',
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    flexShrink: 0,
  },
  legendText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7A6B',
    flex: 1,
  },
});

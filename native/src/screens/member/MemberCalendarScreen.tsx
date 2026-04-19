/**
 * MemberCalendarScreen — Monthly calendar for the member's sessions and goal milestones.
 *
 * Features:
 * - Monthly grid navigation (prev/next)
 * - Day cells with colored event dots
 * - Tap a day to see detailed event cards
 * - "Your Events This Month" fallback when no day is selected
 * - Color-coded by vertical
 * - Legend
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
  ChevronLeft,
  ChevronRight,
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
import { useSessions } from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

function formatTimeShort(time: string): string {
  const [hourStr, minuteStr] = time.split(':');
  const hour = parseInt(hourStr ?? '0', 10);
  const suffix = hour >= 12 ? 'pm' : 'am';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  if (minuteStr === '00') return `${display}${suffix}`;
  return `${display}:${minuteStr}${suffix}`;
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

// ─── Sub-components ───────────────────────────────────────────────────────────

interface DayCellProps {
  day: number;
  events: CalendarEvent[];
  isToday: boolean;
  isSelected: boolean;
  onClick: () => void;
}

function DayCell({ day, events, isToday, isSelected, onClick }: DayCellProps): React.JSX.Element {
  const uniqueColors = Array.from(new Set(events.map(eventColor)));

  return (
    <TouchableOpacity
      onPress={onClick}
      style={[
        dayCellStyles.cell,
        isSelected && dayCellStyles.cellSelected,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${day}${events.length > 0 ? `, ${events.length} event${events.length !== 1 ? 's' : ''}` : ''}`}
      accessibilityState={{ selected: isSelected }}
    >
      {/* Date number */}
      <View style={[
        dayCellStyles.dateCircle,
        isToday && dayCellStyles.dateCircleToday,
      ]}>
        <Text style={[
          dayCellStyles.dateText,
          isToday && dayCellStyles.dateTextToday,
          isSelected && !isToday && dayCellStyles.dateTextSelected,
        ]}>
          {day}
        </Text>
      </View>

      {/* Event dots */}
      {uniqueColors.length > 0 && (
        <View style={dayCellStyles.dotsRow}>
          {uniqueColors.slice(0, 3).map((c, i) => (
            <View
              key={i}
              style={[dayCellStyles.dot, { backgroundColor: c }]}
            />
          ))}
        </View>
      )}
    </TouchableOpacity>
  );
}

const dayCellStyles = StyleSheet.create({
  cell: {
    flex: 1,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    padding: 4,
    margin: 1,
    minHeight: 44,
  },
  cellSelected: {
    backgroundColor: '#3D5A3E15',
  },
  dateCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateCircleToday: {
    backgroundColor: '#3D5A3E',
  },
  dateText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#1E3320',
  },
  dateTextToday: {
    color: '#FFFFFF',
    fontFamily: 'DMSans_700Bold',
  },
  dateTextSelected: {
    color: '#3D5A3E',
    fontFamily: 'DMSans_700Bold',
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 3,
    marginTop: 2,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
});

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

        {/* Time */}
        <View style={eventCardStyles.metaRow}>
          <Clock color={colors.mutedForeground} size={12} />
          <Text style={eventCardStyles.metaText}>
            {formatTimeFull(event.startTime)}
            {event.endTime !== event.startTime ? ` – ${formatTimeFull(event.endTime)}` : ''}
          </Text>
        </View>

        {/* CHW name for sessions */}
        {isSession && event.chwName ? (
          <View style={eventCardStyles.metaRow}>
            <MapPin color={colors.mutedForeground} size={12} />
            <Text style={eventCardStyles.metaText}>With {event.chwName}</Text>
          </View>
        ) : null}

        {/* Milestone indicator */}
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
  const [currentMonth, setCurrentMonth] = useState(new Date(2026, 3, 1)); // April 2026
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const sessionsQuery = useSessions();
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

  const handleDayClick = useCallback((day: number) => {
    setSelectedDay((prev) => (prev === day ? null : day));
  }, []);

  const selectedDateKey = selectedDay !== null ? dateKey(year, month, selectedDay) : null;
  const selectedEvents = selectedDateKey ? (eventsByDate.get(selectedDateKey) ?? []) : [];

  const currentMonthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const eventsThisMonth = memberEvents.filter((e) => e.date.startsWith(currentMonthKey));

  const isToday = (day: number) =>
    year === TODAY_YEAR && month === TODAY_MONTH && day === TODAY_DAY;

  if (sessionsQuery.isLoading) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <View style={{ flex: 1, padding: 16, paddingTop: 20 }}>
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="rows" rows={3} />
        </View>
      </SafeAreaView>
    );
  }

  if (sessionsQuery.error) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <ErrorState
          message="Could not load calendar data. Please try again."
          onRetry={() => void sessionsQuery.refetch()}
        />
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
      >
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
              <ChevronLeft color={colors.mutedForeground} size={20} />
            </TouchableOpacity>
            <Text style={styles.monthTitle}>
              {MONTH_NAMES[month]} {year}
            </Text>
            <TouchableOpacity
              onPress={handleNextMonth}
              style={styles.navBtn}
              accessibilityRole="button"
              accessibilityLabel="Next month"
              hitSlop={8}
            >
              <ChevronRight color={colors.mutedForeground} size={20} />
            </TouchableOpacity>
          </View>

          {/* Day of week header */}
          <View style={styles.dayLabelRow}>
            {DAY_LABELS.map((label) => (
              <Text key={label} style={styles.dayLabel}>{label}</Text>
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
        {selectedDay === null && eventsThisMonth.length > 0 && (
          <View style={styles.detailSection}>
            <Text style={styles.sectionLabel}>YOUR EVENTS THIS MONTH</Text>
            {eventsThisMonth.map((event) => (
              <EventDetailCard key={event.id} event={event} />
            ))}
          </View>
        )}

        {/* Legend */}
        <View style={styles.legendCard}>
          <Text style={styles.legendTitle}>LEGEND</Text>
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
        </View>

        <View style={{ height: 24 }} />
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
    padding: 12,
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
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  navBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#F4F1ED',
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#1E3320',
  },
  dayLabelRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  dayLabel: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
    color: '#6B7280',
    textTransform: 'uppercase',
    textAlign: 'center',
    paddingVertical: 4,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  emptyCell: {
    flex: 1,
    aspectRatio: 1,
    margin: 1,
    minHeight: 44,
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

  // Legend
  legendCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    marginBottom: 8,
    ...Platform.select({
      ios: {
        shadowColor: '#3D5A3E',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 24,
      },
      android: { elevation: 3 },
    }),
  },
  legendTitle: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#6B7280',
    letterSpacing: 1,
    marginBottom: 12,
  },
  legendGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
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

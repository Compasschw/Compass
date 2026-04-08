import { useState, useCallback, useMemo } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  ExternalLink,
} from 'lucide-react';
import { mockCalendarEvents, sessions, goals, verticalLabels } from '../../data/mock';
import type { CalendarEvent, Vertical } from '../../data/mock';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Today's date hardcoded for demo consistency (April 4, 2026). */
const TODAY_YEAR = 2026;
const TODAY_MONTH = 3; // 0-indexed: April
const TODAY_DAY = 4;

/** Demo member whose sessions and milestones we display. */
const DEMO_MEMBER_NAME = 'Rosa Delgado';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Maximum event bars shown per cell before "+N more" overflow label. */
const MAX_BARS_PER_CELL = 3;

/** Bar color per vertical + goal_milestone. */
const verticalColors: Record<Vertical | 'goal_milestone', string> = {
  housing: '#3B82F6',
  rehab: '#EF4444',
  food: '#F59E0B',
  mental_health: '#8B5CF6',
  healthcare: '#06B6D4',
  goal_milestone: '#6B8F71',
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns an array of 7-aligned cells for a given month.
 * Leading nulls pad the first row; trailing nulls complete the final row.
 */
function getMonthDays(year: number, month: number): (number | null)[] {
  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = Array(firstDayOfWeek).fill(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/** Formats a `YYYY-MM-DD` date key from year/month/day numbers. */
function dateKey(year: number, month: number, day: number): string {
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** Groups calendar events by their `date` field into a map keyed by YYYY-MM-DD. */
function groupEventsByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const bucket = map.get(event.date) ?? [];
    map.set(event.date, [...bucket, event]);
  }
  return map;
}

/**
 * Returns the resolved bar background color for a calendar event.
 * Falls back to goal_milestone green when no vertical is set.
 */
function eventBarColor(event: CalendarEvent): string {
  if (event.vertical) return verticalColors[event.vertical];
  return verticalColors.goal_milestone;
}

/**
 * Formats a `HH:MM` 24-hour time string to a compact 12-hour label.
 * Examples: "10:00" -> "10am", "14:00" -> "2pm", "09:30" -> "9:30am"
 */
function formatTimeShort(time: string): string {
  const [hourStr, minuteStr] = time.split(':');
  const hour = parseInt(hourStr, 10);
  const suffix = hour >= 12 ? 'pm' : 'am';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  if (minuteStr === '00') return `${display}${suffix}`;
  return `${display}:${minuteStr}${suffix}`;
}

/**
 * Formats a `HH:MM` 24-hour time string to a full 12-hour label for detail panels.
 * Example: "14:00" -> "2:00 PM"
 */
function formatTimeFull(time: string): string {
  const [hourStr, minuteStr] = time.split(':');
  const hour = parseInt(hourStr, 10);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${minuteStr} ${suffix}`;
}

/** Returns the first name from a full name string. */
function firstName(fullName: string): string {
  return fullName.split(' ')[0];
}

/**
 * Builds the full event list for the member calendar by:
 * 1. Taking mockCalendarEvents filtered to this member's sessions and milestones.
 * 2. Deriving additional CalendarEvent records from the sessions array
 *    (for any session involving DEMO_MEMBER_NAME not already in mockCalendarEvents).
 * 3. Deriving goal milestone events from the goals array using `nextSession` dates.
 *
 * Deduplication is done by date+memberName for sessions and date+goalId for milestones.
 */
function buildMemberEvents(): CalendarEvent[] {
  // Step 1: filter existing mock events to this member only
  const mockMemberEvents = mockCalendarEvents.filter(
    (e) => e.memberName === DEMO_MEMBER_NAME,
  );

  // Build a dedup key set from existing session events
  const existingSessionKeys = new Set<string>(
    mockMemberEvents
      .filter((e) => e.type === 'session')
      .map((e) => `${e.date}|${e.memberName}`),
  );

  // Step 2: derive from sessions array
  const derivedSessionEvents: CalendarEvent[] = sessions
    .filter((session) => {
      if (session.memberName !== DEMO_MEMBER_NAME) return false;
      const dt = new Date(session.scheduledAt);
      const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(dt.getUTCDate()).padStart(2, '0');
      const date = `${dt.getUTCFullYear()}-${mm}-${dd}`;
      return !existingSessionKeys.has(`${date}|${session.memberName}`);
    })
    .map((session) => {
      const dt = new Date(session.scheduledAt);
      const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(dt.getUTCDate()).padStart(2, '0');
      const date = `${dt.getUTCFullYear()}-${mm}-${dd}`;
      const hh = String(dt.getUTCHours()).padStart(2, '0');
      const min = String(dt.getUTCMinutes()).padStart(2, '0');
      const startTime = `${hh}:${min}`;
      const endHour = String(dt.getUTCHours() + 1).padStart(2, '0');
      const endTime = `${endHour}:${min}`;

      return {
        id: `derived-sess-${session.id}`,
        title: `Session with ${firstName(session.chwName)}`,
        date,
        startTime,
        endTime,
        vertical: session.vertical,
        type: 'session' as const,
        chwName: session.chwName,
        memberName: session.memberName,
      };
    });

  // Build a dedup key set from existing milestone events
  const existingMilestoneKeys = new Set<string>(
    mockMemberEvents
      .filter((e) => e.type === 'goal_milestone')
      .map((e) => e.date),
  );

  // Step 3: derive from goals array using nextSession as the milestone date
  const goalMilestoneEvents: CalendarEvent[] = goals
    .filter((goal) => {
      const dt = new Date(goal.nextSession);
      const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(dt.getUTCDate()).padStart(2, '0');
      const date = `${dt.getUTCFullYear()}-${mm}-${dd}`;
      // Avoid adding a milestone on the same date if one already exists for this goal
      return !existingMilestoneKeys.has(`${date}|${goal.id}`);
    })
    .map((goal) => {
      const dt = new Date(goal.nextSession);
      const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(dt.getUTCDate()).padStart(2, '0');
      const date = `${dt.getUTCFullYear()}-${mm}-${dd}`;
      const hh = String(dt.getUTCHours()).padStart(2, '0');
      const min = String(dt.getUTCMinutes()).padStart(2, '0');
      const startTime = `${hh}:${min}`;

      return {
        id: `derived-goal-${goal.id}`,
        title: goal.title,
        date,
        startTime,
        endTime: startTime,
        vertical: goal.category,
        type: 'goal_milestone' as const,
        memberName: DEMO_MEMBER_NAME,
      };
    });

  return [...mockMemberEvents, ...derivedSessionEvents, ...goalMilestoneEvents];
}

// ─── Sub-components ────────────────────────────────────────────────────────────

// ─── EventBar ──────────────────────────────────────────────────────────────────

interface EventBarProps {
  event: CalendarEvent;
  /** When true, renders only the color block + time (no title text). */
  compact?: boolean;
}

/**
 * A single colored inline event bar rendered inside a calendar day cell.
 * For sessions, the label shows the CHW's first name.
 * For milestones, the label shows a truncated goal title.
 * Compact mode is used on narrow screens.
 */
function EventBar({ event, compact = false }: EventBarProps) {
  const color = eventBarColor(event);
  const timeLabel = formatTimeShort(event.startTime);

  let nameLabel: string;
  if (event.type === 'session' && event.chwName) {
    nameLabel = firstName(event.chwName);
  } else {
    nameLabel = event.title;
  }

  return (
    <div
      className="flex items-center gap-[3px] rounded-[4px] px-1.5 overflow-hidden shrink-0"
      style={{ backgroundColor: color, height: 18 }}
      aria-hidden="true"
    >
      <span
        className="text-white font-medium leading-none shrink-0"
        style={{ fontSize: 9 }}
      >
        {timeLabel}
      </span>
      {!compact && (
        <span
          className="text-white leading-none truncate"
          style={{ fontSize: 9 }}
        >
          {nameLabel}
        </span>
      )}
    </div>
  );
}

// ─── DayCell ───────────────────────────────────────────────────────────────────

interface DayCellProps {
  day: number;
  events: CalendarEvent[];
  isToday: boolean;
  isSelected: boolean;
  monthName: string;
  onClick: () => void;
}

/**
 * A single day cell in the monthly calendar grid.
 * Renders the date number and up to MAX_BARS_PER_CELL inline event bars.
 * Excess events are indicated by a "+N more" overflow label.
 */
function DayCell({ day, events, isToday, isSelected, monthName, onClick }: DayCellProps) {
  const visibleEvents = events.slice(0, MAX_BARS_PER_CELL);
  const overflowCount = events.length - visibleEvents.length;

  const baseCellClass = [
    'relative w-full flex flex-col',
    'min-h-[80px] sm:min-h-[100px]',
    'border-b border-r border-[rgba(44,62,45,0.1)]',
    'p-1 cursor-pointer transition-colors',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#6B8F71]',
  ].join(' ');

  let stateClass = 'hover:bg-[#FBF7F0]';
  if (isSelected) {
    stateClass = 'bg-[#F0FBF0] hover:bg-[#E4F7E4]';
  }

  return (
    <button
      role="gridcell"
      aria-label={`${monthName} ${day}${events.length > 0 ? `, ${events.length} event${events.length !== 1 ? 's' : ''}` : ''}`}
      aria-pressed={isSelected}
      className={`${baseCellClass} ${stateClass}`}
      onClick={onClick}
    >
      {/* Date number */}
      <div className="flex items-start justify-start mb-0.5 px-0.5">
        <span
          className={[
            'inline-flex items-center justify-center',
            'text-[11px] font-medium leading-none',
            'w-5 h-5 rounded-full shrink-0',
            isToday
              ? 'bg-[#2C3E2D] text-white'
              : isSelected
              ? 'text-[#6B8F71] font-semibold'
              : 'text-[#2C3E2D]',
          ].join(' ')}
        >
          {day}
        </span>
      </div>

      {/* Event bars */}
      {events.length > 0 && (
        <div className="flex flex-col gap-[2px] px-0.5 overflow-hidden">
          {visibleEvents.map((event) => (
            <div key={event.id} className="contents">
              {/* Full bar: visible on sm+ */}
              <div className="hidden sm:block">
                <EventBar event={event} compact={false} />
              </div>
              {/* Compact bar: visible on xs only */}
              <div className="block sm:hidden">
                <EventBar event={event} compact={true} />
              </div>
            </div>
          ))}

          {overflowCount > 0 && (
            <span
              className="text-[#555555] leading-none px-0.5"
              style={{ fontSize: 9 }}
              aria-hidden="true"
            >
              +{overflowCount} more
            </span>
          )}
        </div>
      )}
    </button>
  );
}

// ─── MemberEventCard ───────────────────────────────────────────────────────────

interface MemberEventCardProps {
  event: CalendarEvent;
  onAddToCalendar: (event: CalendarEvent) => void;
}

/** Detailed event card rendered in the member's day detail panel. */
function MemberEventCard({ event, onAddToCalendar }: MemberEventCardProps) {
  const barColor = eventBarColor(event);
  const isSession = event.type === 'session';

  return (
    <div className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4 flex items-start gap-3">
      {/* Color indicator strip */}
      <div
        className="w-1 self-stretch rounded-full shrink-0"
        style={{ backgroundColor: barColor }}
        aria-hidden="true"
      />

      <div className="flex-1 min-w-0">
        {/* Title + badge */}
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <p className="text-sm font-semibold text-[#2C3E2D] leading-snug">{event.title}</p>
          {event.vertical && (
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium shrink-0"
              style={{
                backgroundColor: `${barColor}20`,
                color: barColor,
              }}
            >
              {verticalLabels[event.vertical]}
            </span>
          )}
          {!event.vertical && event.type === 'goal_milestone' && (
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[rgba(107,143,113,0.15)] text-[#6B8F71] shrink-0">
              Milestone
            </span>
          )}
        </div>

        {/* Time */}
        <div className="flex items-center gap-1.5 mt-1.5">
          <Clock size={12} className="text-[#8B9B8D] shrink-0" aria-hidden="true" />
          <span className="text-xs text-[#555555]">
            {formatTimeFull(event.startTime)}
            {event.endTime !== event.startTime && ` – ${formatTimeFull(event.endTime)}`}
          </span>
        </div>

        {/* CHW name for sessions */}
        {isSession && event.chwName && (
          <div className="flex items-center gap-1.5 mt-1">
            <MapPin size={12} className="text-[#8B9B8D] shrink-0" aria-hidden="true" />
            <span className="text-xs text-[#555555]">With {event.chwName}</span>
          </div>
        )}

        {/* Milestone indicator */}
        {!isSession && (
          <div className="flex items-center gap-1.5 mt-1">
            <CalendarDays size={12} className="text-[#8B9B8D] shrink-0" aria-hidden="true" />
            <span className="text-xs text-[#555555]">Goal milestone</span>
          </div>
        )}

        {/* Add to calendar action */}
        <button
          onClick={() => onAddToCalendar(event)}
          className="flex items-center gap-1.5 mt-3 text-xs font-medium text-[#0077B6] hover:text-[#005a8a] transition-colors"
        >
          <ExternalLink size={12} aria-hidden="true" />
          Add to Calendar
        </button>
      </div>
    </div>
  );
}

// ─── Toast ─────────────────────────────────────────────────────────────────────

interface ToastProps {
  message: string;
}

/** Transient status notification anchored to the top of the viewport. */
function Toast({ message }: ToastProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-[#2C3E2D] text-white text-sm px-4 py-2.5 rounded-[12px] shadow-lg pointer-events-none"
    >
      {message}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

/**
 * Member Calendar page — monthly grid showing Rosa Delgado's sessions and goal
 * milestones with Google Calendar-style inline event bars.
 *
 * Events are built from three sources:
 * 1. mockCalendarEvents filtered to this member
 * 2. Sessions array (sessions where memberName === DEMO_MEMBER_NAME)
 * 3. Goals array (nextSession date becomes a goal_milestone event)
 *
 * Each event card in the detail panel includes a per-event "Add to Calendar" action.
 */
export function MemberCalendar() {
  const [currentMonth, setCurrentMonth] = useState(new Date(2026, 3, 1)); // April 2026
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const cells = getMonthDays(year, month);

  /** Full merged event list for this member — sessions + milestones, deduped. */
  const memberEvents = useMemo<CalendarEvent[]>(() => buildMemberEvents(), []);

  const eventsByDate = useMemo(() => groupEventsByDate(memberEvents), [memberEvents]);

  // ─── Handlers ────────────────────────────────────────────────────────────────

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(null), 2500);
  }, []);

  function handlePrevMonth() {
    setCurrentMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
    setSelectedDay(null);
  }

  function handleNextMonth() {
    setCurrentMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
    setSelectedDay(null);
  }

  function handleDayClick(day: number) {
    setSelectedDay((prev) => (prev === day ? null : day));
  }

  function handleAddToCalendar(event: CalendarEvent) {
    showToast('Event added to calendar!');
    // In a real implementation this would trigger an .ics download or calendar API call.
    void event;
  }

  // ─── Derived ─────────────────────────────────────────────────────────────────

  const selectedDateKey = selectedDay !== null ? dateKey(year, month, selectedDay) : null;
  const selectedEvents = selectedDateKey !== null ? (eventsByDate.get(selectedDateKey) ?? []) : [];

  const isToday = (day: number) =>
    year === TODAY_YEAR && month === TODAY_MONTH && day === TODAY_DAY;

  // Filter events for the current month to show in the "Your Events" panel
  const currentMonthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const eventsThisMonth = memberEvents.filter((e) => e.date.startsWith(currentMonthKey));

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Toast notification */}
      {toastMessage && <Toast message={toastMessage} />}

      {/* Page header */}
      <div>
        <h2 className="text-2xl font-semibold text-[#0077B6]">My Calendar</h2>
        <p className="text-sm text-[#555555] mt-1">
          Your upcoming sessions and goal milestones.
        </p>
      </div>

      {/* Calendar card */}
      <div className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4">
        {/* Month navigation */}
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={handlePrevMonth}
            className="p-1.5 rounded-[12px] text-[#555555] hover:bg-[#FBF7F0] transition-colors"
            aria-label="Previous month"
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </button>

          <h3 className="text-sm font-semibold text-[#2C3E2D]">
            {MONTH_NAMES[month]} {year}
          </h3>

          <button
            onClick={handleNextMonth}
            className="p-1.5 rounded-[12px] text-[#555555] hover:bg-[#FBF7F0] transition-colors"
            aria-label="Next month"
          >
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Day-of-week header */}
        <div className="grid grid-cols-7 border-t border-l border-[rgba(44,62,45,0.1)]" role="row">
          {DAY_LABELS.map((label) => (
            <div
              key={label}
              role="columnheader"
              className="text-xs font-medium text-[#8B9B8D] uppercase text-center py-2 border-b border-r border-[rgba(44,62,45,0.1)]"
            >
              {label}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div
          className="grid grid-cols-7 border-l border-[rgba(44,62,45,0.1)]"
          role="grid"
          aria-label={`${MONTH_NAMES[month]} ${year} calendar`}
        >
          {cells.map((day, index) => {
            if (day === null) {
              return (
                <div
                  key={`empty-${index}`}
                  role="gridcell"
                  aria-hidden="true"
                  className="min-h-[80px] sm:min-h-[100px] border-b border-r border-[rgba(44,62,45,0.1)] bg-[#FAFAFA]"
                />
              );
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
                monthName={MONTH_NAMES[month]}
                onClick={() => handleDayClick(day)}
              />
            );
          })}
        </div>
      </div>

      {/* Day detail panel — shown when a day with events is selected */}
      {selectedDay !== null && (
        <section aria-labelledby="member-day-detail-heading">
          <h3
            id="member-day-detail-heading"
            className="text-sm font-semibold text-[#2C3E2D] uppercase tracking-wide mb-3"
          >
            {MONTH_NAMES[month]} {selectedDay}
          </h3>

          {selectedEvents.length === 0 ? (
            <div className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-6 text-center">
              <CalendarDays size={32} className="text-[rgba(44,62,45,0.1)] mx-auto mb-2" aria-hidden="true" />
              <p className="text-sm text-[#8B9B8D]">No events on this day</p>
            </div>
          ) : (
            <div className="space-y-3">
              {selectedEvents.map((event) => (
                <MemberEventCard
                  key={event.id}
                  event={event}
                  onAddToCalendar={handleAddToCalendar}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* "Your Events This Month" summary — shown when no day is selected */}
      {selectedDay === null && eventsThisMonth.length > 0 && (
        <section aria-labelledby="upcoming-events-heading">
          <h3
            id="upcoming-events-heading"
            className="text-sm font-semibold text-[#2C3E2D] uppercase tracking-wide mb-3"
          >
            Your Events This Month
          </h3>
          <div className="space-y-3">
            {eventsThisMonth.map((event) => (
              <MemberEventCard
                key={event.id}
                event={event}
                onAddToCalendar={handleAddToCalendar}
              />
            ))}
          </div>
        </section>
      )}

      {/* Legend */}
      <div className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4">
        <p className="text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide mb-3">
          Legend
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {(Object.entries(verticalLabels) as [Vertical, string][]).map(([key, label]) => (
            <div key={key} className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: verticalColors[key] }}
                aria-hidden="true"
              />
              <span className="text-xs text-[#555555]">{label}</span>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: verticalColors.goal_milestone }}
              aria-hidden="true"
            />
            <span className="text-xs text-[#555555]">Milestone</span>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState, useCallback, useMemo } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  RefreshCw,
  Check,
} from 'lucide-react';
import { mockCalendarEvents, sessions, verticalLabels } from '../../data/mock';
import type { CalendarEvent, Vertical } from '../../data/mock';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Today's date hardcoded for demo consistency (April 4, 2026). */
const TODAY_YEAR = 2026;
const TODAY_MONTH = 3; // 0-indexed: April
const TODAY_DAY = 4;

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
 * Leading nulls pad to the correct weekday start; trailing nulls fill the
 * last row to a multiple of 7.
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
 * Falls back to goal_milestone green for events without a vertical.
 */
function eventBarColor(event: CalendarEvent): string {
  if (event.vertical) return verticalColors[event.vertical];
  return verticalColors.goal_milestone;
}

/**
 * Formats a `HH:MM` 24-hour time string to a compact 12-hour label.
 * Examples: "10:00" → "10am", "14:00" → "2pm", "09:30" → "9:30am"
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
 * Example: "14:00" → "2:00 PM"
 */
function formatTimeFull(time: string): string {
  const [hourStr, minuteStr] = time.split(':');
  const hour = parseInt(hourStr, 10);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${minuteStr} ${suffix}`;
}

/**
 * Derives CalendarEvent records from the sessions array.
 * Each session's `scheduledAt` ISO string is parsed to extract date and time.
 * Sessions whose date+memberName already appear in `mockCalendarEvents` are
 * skipped to avoid duplicates.
 */
function deriveSessionEvents(): CalendarEvent[] {
  // Build a dedup key set from existing mock events
  const existingKeys = new Set<string>(
    mockCalendarEvents
      .filter((e) => e.type === 'session' && e.memberName)
      .map((e) => `${e.date}|${e.memberName}`),
  );

  return sessions
    .filter((session) => {
      const dt = new Date(session.scheduledAt);
      const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(dt.getUTCDate()).padStart(2, '0');
      const date = `${dt.getUTCFullYear()}-${mm}-${dd}`;
      const key = `${date}|${session.memberName}`;
      return !existingKeys.has(key);
    })
    .map((session) => {
      const dt = new Date(session.scheduledAt);
      const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(dt.getUTCDate()).padStart(2, '0');
      const date = `${dt.getUTCFullYear()}-${mm}-${dd}`;
      const hh = String(dt.getUTCHours()).padStart(2, '0');
      const min = String(dt.getUTCMinutes()).padStart(2, '0');
      const startTime = `${hh}:${min}`;
      // Default to 1-hour duration when no endedAt is available
      const endHour = String(dt.getUTCHours() + 1).padStart(2, '0');
      const endTime = `${endHour}:${min}`;

      const derived: CalendarEvent = {
        id: `derived-${session.id}`,
        title: `Session: ${session.memberName}`,
        date,
        startTime,
        endTime,
        vertical: session.vertical,
        type: 'session',
        chwName: session.chwName,
        memberName: session.memberName,
      };
      return derived;
    });
}

/** Returns the first name from a full name string. */
function firstName(fullName: string): string {
  return fullName.split(' ')[0];
}

// ─── Sub-components ────────────────────────────────────────────────────────────

// ─── EventBar ──────────────────────────────────────────────────────────────────

interface EventBarProps {
  event: CalendarEvent;
  /** When true, renders only the color block + time (no name text). */
  compact?: boolean;
}

/**
 * A single colored inline event bar rendered inside a calendar day cell.
 * Compact mode is used on narrow screens where full names don't fit.
 */
function EventBar({ event, compact = false }: EventBarProps) {
  const color = eventBarColor(event);
  const timeLabel = formatTimeShort(event.startTime);
  const nameLabel = event.memberName ? firstName(event.memberName) : event.title;

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

// ─── EventCard ─────────────────────────────────────────────────────────────────

interface EventCardProps {
  event: CalendarEvent;
}

/** Detailed event card rendered in the day detail panel below the grid. */
function EventCard({ event }: EventCardProps) {
  const isSession = event.type === 'session';
  const barColor = eventBarColor(event);

  return (
    <div className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4 flex items-start gap-3">
      {/* Color indicator strip */}
      <div
        className="w-1 self-stretch rounded-full shrink-0"
        style={{ backgroundColor: barColor }}
        aria-hidden="true"
      />

      <div className="flex-1 min-w-0">
        {/* Title row + vertical badge */}
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

        {/* Member + CHW */}
        {event.memberName && (
          <div className="flex items-center gap-1.5 mt-1">
            {isSession ? (
              <MapPin size={12} className="text-[#8B9B8D] shrink-0" aria-hidden="true" />
            ) : (
              <CalendarDays size={12} className="text-[#8B9B8D] shrink-0" aria-hidden="true" />
            )}
            <span className="text-xs text-[#555555]">
              {event.memberName}
              {isSession && event.chwName && ` · ${event.chwName}`}
            </span>
          </div>
        )}
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

// ─── SyncModal ─────────────────────────────────────────────────────────────────

interface SyncModalProps {
  onClose: () => void;
  onConnectGoogle: () => void;
  onExportIcs: (provider: 'apple' | 'outlook') => void;
  syncingProvider: string | null;
}

/** Full-screen modal for calendar sync / export options. */
function SyncModal({ onClose, onConnectGoogle, onExportIcs, syncingProvider }: SyncModalProps) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-modal-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="relative bg-white rounded-[16px] max-w-sm w-full mx-auto p-5 shadow-xl z-10">
        <div className="flex items-center justify-between mb-4">
          <h2 id="sync-modal-title" className="text-base font-semibold text-[#2C3E2D]">
            Sync Calendar
          </h2>
          <button
            onClick={onClose}
            className="text-[#8B9B8D] hover:text-[#555555] transition-colors p-1 rounded"
            aria-label="Close sync modal"
          >
            <span className="text-lg leading-none" aria-hidden="true">x</span>
          </button>
        </div>

        <p className="text-xs text-[#555555] mb-5 leading-relaxed">
          Connect your calendar to keep sessions in sync, or export an .ics file to import manually.
        </p>

        <div className="space-y-3">
          {/* Google Calendar */}
          <div className="border border-[rgba(44,62,45,0.1)] rounded-[12px] p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-white border border-[rgba(44,62,45,0.1)] flex items-center justify-center shrink-0 shadow-sm">
                <span
                  className="font-bold text-base"
                  style={{
                    background: 'linear-gradient(135deg, #4285F4 25%, #EA4335 25%, #EA4335 50%, #FBBC05 50%, #FBBC05 75%, #34A853 75%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                  }}
                  aria-hidden="true"
                >
                  G
                </span>
              </div>
              <div>
                <p className="text-sm font-medium text-[#2C3E2D]">Google Calendar</p>
                <p className="text-xs text-[#8B9B8D]">Two-way sync</p>
              </div>
            </div>
            <button
              onClick={onConnectGoogle}
              disabled={syncingProvider === 'google'}
              className="shrink-0 flex items-center gap-1.5 bg-[#2C3E2D] text-white text-xs font-medium px-3 py-1.5 rounded-[12px] hover:bg-[#009040] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {syncingProvider === 'google' ? (
                <>
                  <RefreshCw size={12} className="animate-spin" aria-hidden="true" />
                  Connecting...
                </>
              ) : (
                'Connect'
              )}
            </button>
          </div>

          {/* Apple Calendar */}
          <div className="border border-[rgba(44,62,45,0.1)] rounded-[12px] p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-[#FBF7F0] border border-[rgba(44,62,45,0.1)] flex items-center justify-center shrink-0">
                <CalendarDays size={18} className="text-[#555555]" aria-hidden="true" />
              </div>
              <div>
                <p className="text-sm font-medium text-[#2C3E2D]">Apple Calendar</p>
                <p className="text-xs text-[#8B9B8D]">Export .ics file</p>
              </div>
            </div>
            <button
              onClick={() => onExportIcs('apple')}
              className="shrink-0 text-xs font-medium text-[#0077B6] border border-[#0077B6] px-3 py-1.5 rounded-[12px] hover:bg-blue-50 transition-colors"
            >
              Export .ics
            </button>
          </div>

          {/* Outlook */}
          <div className="border border-[rgba(44,62,45,0.1)] rounded-[12px] p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-[#F0F4FF] border border-[rgba(44,62,45,0.1)] flex items-center justify-center shrink-0">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <rect x="2" y="4" width="20" height="16" rx="2" fill="#0078D4" />
                  <path d="M2 8L12 14L22 8" stroke="white" strokeWidth="1.5" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-[#2C3E2D]">Outlook</p>
                <p className="text-xs text-[#8B9B8D]">Export for Outlook</p>
              </div>
            </div>
            <button
              onClick={() => onExportIcs('outlook')}
              className="shrink-0 text-xs font-medium text-[#0077B6] border border-[#0077B6] px-3 py-1.5 rounded-[12px] hover:bg-blue-50 transition-colors"
            >
              Export .ics
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

/**
 * CHW Calendar page — full monthly grid with Google Calendar-style inline event
 * bars auto-populated from both `mockCalendarEvents` and the `sessions` array.
 *
 * Features:
 * - Inline event bars per day cell (time + member first name)
 * - Up to 3 bars with "+N more" overflow label
 * - Day detail panel on cell click
 * - Google Calendar sync / .ics export modal
 * - Connected badge after sync
 */
export function CHWCalendar() {
  const [currentMonth, setCurrentMonth] = useState(new Date(2026, 3, 1)); // April 2026
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncingProvider, setSyncingProvider] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const cells = getMonthDays(year, month);

  /**
   * All calendar events for the CHW view — merges mockCalendarEvents with
   * events derived from the sessions array (deduped by date + memberName).
   */
  const allEvents = useMemo<CalendarEvent[]>(() => {
    const derived = deriveSessionEvents();
    return [...mockCalendarEvents, ...derived];
  }, []);

  const eventsByDate = useMemo(() => groupEventsByDate(allEvents), [allEvents]);

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

  function handleConnectGoogle() {
    setSyncingProvider('google');
    setTimeout(() => {
      setCalendarConnected(true);
      setSyncingProvider(null);
      setShowSyncModal(false);
      showToast('Connected to Google Calendar!');
    }, 1500);
  }

  function handleExportIcs(provider: 'apple' | 'outlook') {
    const filename = provider === 'apple' ? 'calendar.ics' : 'outlook-calendar.ics';
    setShowSyncModal(false);
    showToast(`${filename} exported!`);
  }

  // ─── Derived ─────────────────────────────────────────────────────────────────

  const selectedDateKey = selectedDay !== null ? dateKey(year, month, selectedDay) : null;
  const selectedEvents = selectedDateKey !== null ? (eventsByDate.get(selectedDateKey) ?? []) : [];

  const isToday = (day: number) =>
    year === TODAY_YEAR && month === TODAY_MONTH && day === TODAY_DAY;

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Toast notification */}
      {toastMessage && <Toast message={toastMessage} />}

      {/* Sync modal overlay */}
      {showSyncModal && (
        <SyncModal
          onClose={() => setShowSyncModal(false)}
          onConnectGoogle={handleConnectGoogle}
          onExportIcs={handleExportIcs}
          syncingProvider={syncingProvider}
        />
      )}

      {/* Page header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-[#0077B6]">Calendar</h2>
          {calendarConnected && (
            <div className="flex items-center gap-1.5 mt-1">
              <Check size={12} className="text-[#6B8F71]" aria-hidden="true" />
              <span className="text-xs font-medium text-[#6B8F71]">
                Connected to Google Calendar
              </span>
            </div>
          )}
        </div>

        {calendarConnected ? (
          <div className="flex items-center gap-1.5 bg-[rgba(107,143,113,0.15)] text-[#6B8F71] text-xs font-medium px-3 py-1.5 rounded-[12px]">
            <Check size={13} aria-hidden="true" />
            Connected
          </div>
        ) : (
          <button
            onClick={() => setShowSyncModal(true)}
            className="flex items-center gap-1.5 border border-[#6B8F71] text-[#6B8F71] text-xs font-medium px-3 py-1.5 rounded-[12px] hover:bg-[rgba(107,143,113,0.15)] transition-colors"
          >
            <RefreshCw size={13} aria-hidden="true" />
            Sync Calendar
          </button>
        )}
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

      {/* Day detail panel */}
      {selectedDay !== null && (
        <section aria-labelledby="chw-day-detail-heading">
          <h3
            id="chw-day-detail-heading"
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
                <EventCard key={event.id} event={event} />
              ))}
            </div>
          )}
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

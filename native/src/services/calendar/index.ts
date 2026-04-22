/**
 * Device calendar integration — "Add to calendar" action for upcoming
 * sessions. Wraps `expo-calendar` so callers don't have to deal with the
 * permission dance or the source/calendar selection.
 *
 * Default provider: no-op. The real provider is loaded lazily when
 * `expo-calendar` is installed — if the module isn't present we silently
 * bail on `addSession()` rather than throwing, so screens can always call
 * it without feature-flag noise.
 *
 * Install to activate:
 *   npx expo install expo-calendar
 *   // add "NSCalendarsUsageDescription" to app.json ios.infoPlist
 */

export interface CalendarSessionEvent {
  /** Backend session id — used as the event's deep-link slot + dedupe key. */
  id: string;
  /** Human-readable title, e.g. "CHW Session · Housing". */
  title: string;
  /** Absolute start time (ISO 8601). */
  startIso: string;
  /** Absolute end time (ISO 8601). */
  endIso: string;
  /** Optional notes for the calendar event body. */
  notes?: string;
  /** Optional in-person street address for the calendar location field. */
  location?: string;
}

export interface CalendarProvider {
  /** Returns true if the device can write to calendars (permission + module). */
  isAvailable(): Promise<boolean>;
  /** Request calendar permissions; no-op if already granted. Returns true on grant. */
  requestPermission(): Promise<boolean>;
  /**
   * Add a session to the user's default calendar. Returns the created
   * event id if successful, or null if the provider no-ops.
   */
  addSession(event: CalendarSessionEvent): Promise<string | null>;
}

// ─── Module-detection helper ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedModule: any | null | undefined;

function loadExpoCalendar(): unknown | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    cachedModule = require('expo-calendar');
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

// ─── Real provider (expo-calendar) ───────────────────────────────────────────

class ExpoCalendarProvider implements CalendarProvider {
  async isAvailable(): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = loadExpoCalendar();
    if (!mod) return false;
    const { status } = await mod.getCalendarPermissionsAsync();
    return status === 'granted';
  }

  async requestPermission(): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = loadExpoCalendar();
    if (!mod) return false;
    const { status } = await mod.requestCalendarPermissionsAsync();
    return status === 'granted';
  }

  async addSession(event: CalendarSessionEvent): Promise<string | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = loadExpoCalendar();
    if (!mod) return null;

    const { status } = await mod.requestCalendarPermissionsAsync();
    if (status !== 'granted') return null;

    // Find (or fall back to) the default calendar. We prefer the OS default
    // so events land where the user expects them.
    const calendars: Array<{ id: string; isPrimary?: boolean; source?: { name?: string } }> =
      await mod.getCalendarsAsync(mod.EntityTypes.EVENT);
    const defaultCal =
      calendars.find((c) => c.isPrimary) ??
      calendars.find((c) => c.source?.name === 'Default') ??
      calendars[0];
    if (!defaultCal) return null;

    const eventId: string = await mod.createEventAsync(defaultCal.id, {
      title: event.title,
      startDate: new Date(event.startIso),
      endDate: new Date(event.endIso),
      notes: event.notes,
      location: event.location,
      // Deep-link back to the app on tap (Android will open a generic URL,
      // iOS calendar ignores the field — harmless on both).
      url: `compasschw://sessions/${event.id}`,
    });
    return eventId;
  }
}

// ─── Noop provider ───────────────────────────────────────────────────────────

class NoopCalendarProvider implements CalendarProvider {
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async requestPermission(): Promise<boolean> {
    return false;
  }
  async addSession(): Promise<string | null> {
    return null;
  }
}

// ─── Factory + singleton ─────────────────────────────────────────────────────

function createCalendarProvider(): CalendarProvider {
  return loadExpoCalendar() ? new ExpoCalendarProvider() : new NoopCalendarProvider();
}

export const calendar: CalendarProvider = createCalendarProvider();

/*
 * Dates and times for the UI (F-108, maw-design-system §10): British English formats ("15 Nov 2026", "14:05") in the
 * viewer's own time zone, from the ISO 8601 UTC strings the API sends. `timeZone` exists so tests (and any later
 * per-user setting) can pin one; leaving it out uses the device's zone.
 */

const LOCALE = 'en-GB';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** From this many calendar days back, a timestamp shows its date instead of "… days ago". */
const DAYS_SHOWN_RELATIVE = 7;

export interface FormatOptions {
  /** IANA zone such as `Europe/Berlin`; default: the device's zone. */
  timeZone?: string;
}

type DateInput = string | number | Date;

const DATE: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
/** Only read through `formatToParts`, to find the calendar day an instant falls on in a zone. */
const CALENDAR_DAY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'numeric', year: 'numeric' };
const STYLES = { date: DATE, time: TIME, dateTime: { ...DATE, ...TIME }, calendarDay: CALENDAR_DAY };
type Style = keyof typeof STYLES;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** `Intl.DateTimeFormat` is costly to build, and a chat page formats hundreds of timestamps: one per style and zone. */
function formatter(style: Style, timeZone: string | undefined): Intl.DateTimeFormat {
  const key = `${style}|${timeZone ?? ''}`;
  let cached = formatters.get(key);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat(LOCALE, timeZone === undefined ? STYLES[style] : { ...STYLES[style], timeZone });
    formatters.set(key, cached);
  }
  return cached;
}

const relativeFormat = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

/** A valid `Date` for an ISO string, epoch milliseconds or a `Date`; `null` when it cannot be read. */
export function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function format(style: Style, value: DateInput, options: FormatOptions): string {
  const date = toDate(value);
  // An unreadable value is shown as it came rather than as "Invalid Date".
  return date === null ? String(value) : formatter(style, options.timeZone).format(date);
}

/** "15 Nov 2026". */
export function formatDate(value: DateInput, options: FormatOptions = {}): string {
  return format('date', value, options);
}

/** "14:05" (24-hour clock). */
export function formatTime(value: DateInput, options: FormatOptions = {}): string {
  return format('time', value, options);
}

/** "15 Nov 2026, 14:05": the absolute form for a `<time>` element's title next to a relative label. */
export function formatDateTime(value: DateInput, options: FormatOptions = {}): string {
  return format('dateTime', value, options);
}

/**
 * The calendar day `date` falls on in `timeZone`, as a day count since 1 Jan 1970. Differences of two such counts are
 * the midnights between the instants in that zone, which is what "yesterday" means (24-hour blocks are not: 23:30 and
 * 01:00 of the same day are 22.5 hours apart).
 */
function calendarDay(date: Date, timeZone: string | undefined): number {
  const parts = new Map(
    formatter('calendarDay', timeZone)
      .formatToParts(date)
      .map(({ type, value }) => [type, Number(value)]),
  );
  return Date.UTC(parts.get('year') ?? 0, (parts.get('month') ?? 1) - 1, parts.get('day') ?? 1) / DAY;
}

/**
 * Relative to `now` with `Intl.RelativeTimeFormat` (F-69): "just now" under 45 seconds, then "5 minutes ago" and
 * "3 hours ago" (by elapsed time); after that by calendar day in the viewer's zone (F-108): "yesterday", "4 days ago",
 * and from seven days on the date itself ("15 Nov 2026"), which reads better than "7 weeks ago". Anything from the
 * same calendar day stays in hours, so a morning post never reads "yesterday" late that evening. A timestamp slightly
 * in the future (clock skew between server and device) reads "just now".
 */
export function formatRelative(value: DateInput, now: number | Date = Date.now(), options: FormatOptions = {}): string {
  const date = toDate(value);
  if (date === null) {
    return String(value);
  }
  const nowDate = now instanceof Date ? now : new Date(now);
  const elapsed = nowDate.getTime() - date.getTime();

  if (elapsed < 45 * SECOND) {
    return 'just now';
  }
  if (elapsed < 45 * MINUTE) {
    return relativeFormat.format(-Math.max(1, Math.round(elapsed / MINUTE)), 'minute');
  }
  const daysAgo = calendarDay(nowDate, options.timeZone) - calendarDay(date, options.timeZone);
  if (elapsed < 22 * HOUR || daysAgo === 0) {
    return relativeFormat.format(-Math.max(1, Math.round(elapsed / HOUR)), 'hour');
  }
  if (daysAgo < DAYS_SHOWN_RELATIVE) {
    return relativeFormat.format(-daysAgo, 'day');
  }
  return formatDate(date, options);
}

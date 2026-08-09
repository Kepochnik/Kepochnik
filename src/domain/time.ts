/**
 * Time handling rules for Squeakly.
 *
 * 1. Every timestamp is stored as epoch milliseconds (UTC). No local time strings.
 * 2. Every row that is ever grouped by day also stores denormalised local fields
 *    (`localDay`, `localHour`, `localDow`) computed from the timezone offset that
 *    was in effect *at the moment of the event*. A 2am event stays "yesterday
 *    night" forever, even if the user flies to another timezone tomorrow, and the
 *    hour-of-day chart stays truthful.
 * 3. Local fields are derived from (epochMs, tzOffsetMinutes) by a pure function,
 *    so the widget only has to record those two numbers and the app derives the
 *    rest at drain time. The native side stays dumb on purpose.
 */

export type LocalDay = string; // 'YYYY-MM-DD'
export type IsoWeek = string; // '2026-W32'

export interface LocalFields {
  /** 'YYYY-MM-DD' as experienced by the user. */
  localDay: LocalDay;
  /** 0..23 */
  localHour: number;
  /** 0 = Sunday .. 6 = Saturday, matching `Date.prototype.getDay`. */
  localDow: number;
  /** Minutes *ahead* of UTC. Moscow = +180, New York (DST) = -240. */
  tzOffset: number;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** Minutes ahead of UTC for the device right now (inverse of `getTimezoneOffset`). */
export function currentTzOffset(at: Date = new Date()): number {
  return -at.getTimezoneOffset();
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/**
 * Shifts the instant by the offset and then reads it with UTC getters, which makes
 * the result independent of the device's *current* timezone.
 */
export function deriveLocalFields(epochMs: number, tzOffset: number): LocalFields {
  const shifted = new Date(epochMs + tzOffset * MS_PER_MINUTE);
  return {
    localDay: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    localHour: shifted.getUTCHours(),
    localDow: shifted.getUTCDay(),
    tzOffset,
  };
}

/** Local fields for an instant using the device's current offset. */
export function localFieldsNow(epochMs: number = Date.now()): LocalFields {
  return deriveLocalFields(epochMs, currentTzOffset(new Date(epochMs)));
}

export function toLocalDay(date: Date): LocalDay {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseLocalDay(day: LocalDay): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, date ?? 1);
}

export function todayLocalDay(now: Date = new Date()): LocalDay {
  return toLocalDay(now);
}

/** Adds whole days in *local* terms, DST-safe because it goes through the Date constructor. */
export function addLocalDays(day: LocalDay, delta: number): LocalDay {
  const date = parseLocalDay(day);
  date.setDate(date.getDate() + delta);
  return toLocalDay(date);
}

/** Whole days between two local days, positive when `b` is later than `a`. */
export function localDayDiff(a: LocalDay, b: LocalDay): number {
  const from = parseLocalDay(a);
  const to = parseLocalDay(b);
  // Normalise to UTC noon to make the subtraction immune to DST transitions.
  const fromUtc = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate(), 12);
  const toUtc = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate(), 12);
  return Math.round((toUtc - fromUtc) / MS_PER_DAY);
}

/** Inclusive list of local days, oldest first. */
export function localDayRange(from: LocalDay, to: LocalDay): LocalDay[] {
  const days: LocalDay[] = [];
  const span = localDayDiff(from, to);
  for (let i = 0; i <= span; i += 1) days.push(addLocalDays(from, i));
  return days;
}

/** The last `count` local days ending today, oldest first. */
export function trailingLocalDays(count: number, now: Date = new Date()): LocalDay[] {
  const today = toLocalDay(now);
  return localDayRange(addLocalDays(today, -(count - 1)), today);
}

/**
 * ISO-8601 week key, e.g. '2026-W32'. Used as the leaderboard bucket, so client and
 * Postgres must agree — the server computes the same value with `to_char(ts,'IYYY-"W"IW')`.
 */
export function isoWeekKey(date: Date = new Date()): IsoWeek {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Thursday of the current ISO week decides the year and week number.
  const dayNumber = (target.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
  return `${isoYear}-W${pad(week)}`;
}

/** Local days belonging to the ISO week that contains `now`, Monday first. */
export function currentIsoWeekDays(now: Date = new Date()): LocalDay[] {
  const dayNumber = (now.getDay() + 6) % 7; // Monday = 0
  const monday = addLocalDays(toLocalDay(now), -dayNumber);
  return localDayRange(monday, addLocalDays(monday, 6));
}

import { zonedMidnight } from '../grading/index.js';

const DAY_MS = 86_400_000;

export type BucketSize = 'week' | 'day';

/** Building a formatter costs far more than using one; a trend query formats thousands of instants. */
const formats = new Map<string, Intl.DateTimeFormat>();

/** The calendar date (as UTC midnight of that date) a clock reads in `timeZone` at `at`. */
export function localDate(at: Date, timeZone: string): number {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
    formats.set(timeZone, format);
  }
  const p = format.formatToParts(at);
  const n = (t: string): number => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'));
}

/** Monday on or before the given date (ISO weeks start on Monday). */
const mondayOf = (date: number): number => date - ((new Date(date).getUTCDay() + 6) % 7) * DAY_MS;

export interface Bucket {
  /** The local date the bucket starts on, as UTC midnight of that date (the map key). */
  key: number;
  /** The instant the bucket starts: midnight of that date in the time zone. */
  start: Date;
}

/**
 * Consecutive buckets ending with the one that holds `now`: `weeks` ISO weeks, or `weeks * 7` days.
 * Empty periods are kept so the chart has no gaps.
 */
export function bucketsFor(now: Date, timeZone: string, weeks: number, size: BucketSize): Bucket[] {
  const today = localDate(now, timeZone);
  const step = size === 'week' ? 7 * DAY_MS : DAY_MS;
  const last = size === 'week' ? mondayOf(today) : today;
  const count = size === 'week' ? weeks : weeks * 7;
  const out: Bucket[] = [];
  for (let key = last - (count - 1) * step; key <= last; key += step) {
    const d = new Date(key);
    out.push({
      key,
      start: zonedMidnight(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), timeZone),
    });
  }
  return out;
}

const MONTH_MS = 30 * DAY_MS;
const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** UTC offset of a zone at an instant, in minutes. */
function offsetMinutes(at: Date, timeZone: string): number {
  let format = offsetFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
    offsetFormats.set(timeZone, format);
  }
  const name = format.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/**
 * The coarsest slot a bucket boundary of the zone cannot fall inside: one hour when the zone's UTC
 * offset is a whole number of hours (sampled monthly over the range, which catches DST), else a quarter
 * of one. Fewer slots mean fewer rows to group and to map.
 */
export function slotSecondsFor(from: Date, to: Date, timeZone: string): 3600 | 900 {
  for (let at = from.getTime(); at < to.getTime() + MONTH_MS; at += MONTH_MS) {
    if (offsetMinutes(new Date(Math.min(at, to.getTime())), timeZone) % 60 !== 0) return 900;
  }
  return 3600;
}

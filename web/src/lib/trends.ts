import type { TrendBucketSize, Trends } from '../api/types.js';

/** A bucket with fewer graded sessions than this is drawn hollow: one more session could move it a lot. */
export const LOW_SAMPLE = 5;

/** "silent-workaround" -> "Silent workaround". */
export function rubricLabel(name: string): string {
  const s = name.replaceAll('-', ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Series colour by position in the (sorted) rubric list, so a rubric keeps its colour under any filter. */
export const seriesColor = (index: number) => `var(--series-${String(Math.min(index, 7) + 1)})`;

export const pct = (rate: number | null) =>
  rate === null ? '–' : `${String(Math.round(rate * 100))}%`;

const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLocal = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
export const formatDay = (iso: string) => day.format(new Date(iso));
export const formatDayLocal = (iso: string) => dayLocal.format(new Date(iso));

/** ISO-8601 week number of the (UTC) date. */
export function isoWeek(iso: string): number {
  const d = new Date(iso);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const thursday = new Date(t + (3 - ((d.getUTCDay() + 6) % 7)) * 86_400_000);
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - jan1) / (7 * 86_400_000)) + 1;
}

export const bucketTick = (iso: string, bucket: TrendBucketSize) =>
  bucket === 'week' ? `W${String(isoWeek(iso))}` : formatDay(iso);
export const bucketTitle = (iso: string, bucket: TrendBucketSize) =>
  bucket === 'week' ? `Week of ${formatDay(iso)}` : formatDay(iso);

/** The bucket a moment falls in: the last one that starts at or before it; null before the first. */
export function bucketOf(buckets: Trends['buckets'], at: string): string | null {
  let found: string | null = null;
  for (const b of buckets) if (b.start <= at) found = b.start;
  return found;
}

/** Whole 10% steps around the data and the targets, never past 0 to 100%. */
export function yAxis(values: number[]): { domain: [number, number]; ticks: number[] } {
  const lo = Math.max(0, Math.floor(Math.min(...values) * 10) / 10 - 0.1);
  const hi = Math.min(1, Math.ceil(Math.max(...values) * 10) / 10 + 0.1);
  const ticks: number[] = [];
  for (let t = Math.round(lo * 10); t <= Math.round(hi * 10); t++) ticks.push(t / 10);
  return { domain: [lo, hi], ticks };
}

export function gradedTotal(t: Trends): number {
  return t.buckets.reduce(
    (n, b) => n + Object.values(b.rubrics).reduce((m, r) => m + r.graded, 0),
    0,
  );
}

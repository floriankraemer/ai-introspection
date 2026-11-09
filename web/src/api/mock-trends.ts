import type { Api, Job, TrendChange, TrendMarker, Trends } from './types.js';

const DAY = 86_400_000;

/** Monday 00:00 UTC of the week that holds `t`. */
function weekStart(t: number): number {
  const d = new Date(t);
  const back = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
}

const iso = (t: number) => new Date(t).toISOString();
const noise = (i: number, k: number) => Math.sin(i * 12.9898 + k * 78.233) * 0.025;

/** Weekly pass rate for `rubric`, `w` weeks ago (11 = oldest week with data, 0 = this week). */
const RATE: Record<string, (w: number) => number> = {
  // Fix 1 (e2e port discovery) lands 6 weeks ago: a clear jump.
  efficiency: (w) => (w > 6 ? 0.57 : 0.74) + noise(w, 1),
  // Fix 2 (manual CLAUDE.md edit) is only 2 weeks old: too early to tell.
  'redundant-tests': (w) => 0.65 + noise(w, 2),
  verbosity: (w) => 0.86 + noise(w, 3),
  // Rubric v2 five weeks ago: the line before it is not like-for-like with the one after.
  'silent-workaround': (w) => (w > 5 ? 0.63 : 0.76) + noise(w, 4),
};
const TARGET_NAMES = Object.keys(RATE);

/** Graded sessions in the week: the oldest and the running week are thin on purpose. */
const gradedIn = (w: number) => (w === 11 ? 3 : w === 0 ? 4 : 9 + ((w * 7) % 6));

function build(weeks: number, bucket: 'week' | 'day', now: number): Trends {
  const buckets: Trends['buckets'] = [];
  const thisWeek = weekStart(now);
  const point = (w: number, i: number, per: number) => {
    const rubrics: Trends['buckets'][number]['rubrics'] = {};
    for (const name of TARGET_NAMES) {
      const graded = w > 11 ? 0 : Math.max(per === 1 ? 0 : 1, Math.round(gradedIn(w) / per));
      const rate = RATE[name]?.(w) ?? 0;
      const passRate =
        graded === 0 ? null : Math.min(1, Math.max(0, rate + (per > 1 ? noise(i, 9) * 2 : 0)));
      rubrics[name] = {
        passRate: passRate === null ? null : Math.round(passRate * 100) / 100,
        graded,
        passed: passRate === null ? 0 : Math.round(passRate * graded),
      };
    }
    return rubrics;
  };
  if (bucket === 'week') {
    for (let w = weeks - 1; w >= 0; w--)
      buckets.push({ start: iso(thisWeek - w * 7 * DAY), rubrics: point(w, w, 1) });
  } else {
    const today = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    );
    for (let d = weeks * 7 - 1; d >= 0; d--) {
      const start = today - d * DAY;
      const w = Math.floor((thisWeek - weekStart(start)) / (7 * DAY));
      buckets.push({ start: iso(start), rubrics: point(w, d, 7) });
    }
  }
  const from = buckets[0] ? Date.parse(buckets[0].start) : now;
  const markers = markersOf(thisWeek).filter((m) => Date.parse(m.at) >= from);
  const baselineResets = [
    {
      at: iso(thisWeek - 5 * 7 * DAY + 2 * DAY),
      rubric: 'silent-workaround',
      reason: 'Rubric changed from version 1 to 2',
    },
  ].filter((r) => Date.parse(r.at) >= from);
  return { buckets, markers, baselineResets };
}

function markersOf(thisWeek: number): TrendMarker[] {
  return [
    {
      id: 'm-fix-1',
      at: iso(thisWeek - 6 * 7 * DAY + 2 * DAY),
      kind: 'proposal_merged',
      title: 'e2e-testing: find dev-server port first',
      proposalId: 'p1',
      files: ['skills/e2e-testing/SKILL.md'],
      rubrics: ['efficiency'],
    },
    {
      id: 'm-reset-1',
      at: iso(thisWeek - 5 * 7 * DAY + 2 * DAY),
      kind: 'rubric_changed',
      title: 'Rubric changed: silent-workaround v2',
      proposalId: null,
      files: ['rubrics/silent-workaround.md'],
      rubrics: ['silent-workaround'],
    },
    {
      id: 'm-fix-2',
      at: iso(thisWeek - 2 * 7 * DAY + 1 * DAY),
      kind: 'manual_edit',
      title: 'CLAUDE.md: prefer e2e over unit tests for auth',
      proposalId: null,
      files: ['CLAUDE.md'],
      rubrics: ['redundant-tests'],
    },
  ];
}

function changesOf(thisWeek: number): TrendChange[] {
  const [fix1, reset, fix2] = markersOf(thisWeek) as [TrendMarker, TrendMarker, TrendMarker];
  const of = (m: TrendMarker) => ({
    at: m.at,
    title: m.title,
    kind: m.kind,
    proposalId: m.proposalId,
    files: m.files,
    rubrics: m.rubrics,
  });
  const [f1, r1, f2] = [of(fix1), of(reset), of(fix2)];
  return [
    {
      ...f2,
      id: 'ch-3',
      before: { passRate: 0.64, graded: 19, window: 7 },
      after: { passRate: 0.66, graded: 3, window: 7 },
      verdict: 'too_early',
    },
    {
      ...r1,
      id: 'ch-2',
      before: { passRate: 0.63, graded: 21, window: 7 },
      after: { passRate: 0.77, graded: 17, window: 7 },
      verdict: 'no_change',
    },
    {
      ...f1,
      id: 'ch-1',
      before: { passRate: 0.58, graded: 14, window: 7 },
      after: { passRate: 0.72, graded: 18, window: 7 },
      verdict: 'improved',
    },
  ];
}

/** Trends fixtures: 12 weeks of data, two merged fixes (one clear, one too early), one rubric change. */
export function createTrendsApi(
  withData: boolean,
  wait: () => Promise<void>,
  regrade: () => Job,
): Pick<Api, 'getTrends' | 'listTrendChanges' | 'startReferenceRegrade'> {
  return {
    async getTrends({ weeks, bucket }) {
      await wait();
      if (withData) return build(weeks, bucket, Date.now());
      return { buckets: [], markers: [], baselineResets: [] };
    },
    async listTrendChanges() {
      await wait();
      return withData ? changesOf(weekStart(Date.now())) : [];
    },
    async startReferenceRegrade() {
      await wait();
      return regrade();
    },
  };
}

import { fromJson } from '../../platform/db/json.js';
import { ConflictError, NotFoundError } from '../../platform/errors.js';
import type { Db } from '../../platform/db/schema.js';
import type { JobHandler } from '../../platform/jobs/worker.js';
import type { Schedule } from '../../platform/jobs/scheduler.js';
import { type Grading, type JudgeProvider, type RangeCount } from '../grading/index.js';
import type { SkillRepos } from '../improvement/index.js';
import type { IngestService } from '../ingest/index.js';
import type { RubricStore } from '../rubrics/index.js';
import type { SettingsService } from '../settings/index.js';
import { bucketsFor, slotSecondsFor, type BucketSize } from './buckets.js';
import { createChangeScan } from './scan.js';
import { verdictOf, type ChangeVerdict, type Tally } from './verdict.js';

export { verdictOf, type ChangeVerdict } from './verdict.js';
export { bucketsFor } from './buckets.js';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
export const TRENDS_SCAN_JOB = 'trends_scan';
/** Manual edits are noticed within this time (the build plan asks for 15 minutes). */
const SCAN_CRON = '*/15 * * * *';
/** The reference set is a fixed, small sample: it is re-graded in full after every change. */
export const REFERENCE_TARGET_SIZE = 20;
/** The change log lists at most this many of the newest events. */
const MAX_CHANGES = 50;
const CHANGE_LOG_WEEKS = 26;

export type MarkerKind = 'proposal_merged' | 'manual_edit' | 'rubric_changed';

export interface TrendMarker {
  id: string;
  at: string;
  kind: MarkerKind;
  title: string;
  proposalId: string | null;
  files: string[];
  rubrics: string[];
}

export interface TrendSeries {
  buckets: {
    start: string;
    rubrics: Record<string, { passRate: number | null; graded: number; passed: number }>;
  }[];
  markers: TrendMarker[];
  baselineResets: { at: string; rubric: string; reason: string }[];
}

export interface WindowStats {
  passRate: number | null;
  graded: number;
  /** Length of the compared window in days. */
  window: number;
}

export interface TrendChange extends TrendMarker {
  before: WindowStats;
  after: WindowStats;
  verdict: ChangeVerdict;
}

export interface TrendSummary {
  days: number;
  sessionsCollected: number;
  sessionsGraded: number;
  rubrics: { name: string; passRate: number | null; target: number; gradedCount: number }[];
}

export interface ReferenceSession {
  id: string;
  title: string;
  startedAt: string | null;
  grades: { rubric: string; passed: boolean | null; status: string }[];
}

export interface TrendsDeps {
  db: Db;
  workspaceId: string;
  settings: Pick<SettingsService, 'get'>;
  ingest: Pick<IngestService, 'sessions' | 'setReference'>;
  grading: Pick<
    Grading,
    | 'passCounts'
    | 'passCountsInRanges'
    | 'trendRubrics'
    | 'enqueueBatch'
    | 'enqueueBatchOnce'
    | 'gradesFor'
  >;
  rubrics: Pick<RubricStore, 'list'>;
  judges: Pick<JudgeProvider, 'current'>;
  skillRepos: Pick<SkillRepos, 'rows' | 'refreshDefaultBranch'>;
  /** IANA time zone the trend buckets follow; default UTC. */
  timeZone?: string;
  now?: () => Date;
}

const rate = (t: Tally): number | null => (t.graded === 0 ? null : t.passed / t.graded);

/** Trend series, change log, change detection and the reference set (overview sections 6.4 and 9). */
export function createTrends(deps: TrendsDeps) {
  const { db, workspaceId } = deps;
  const timeZone = deps.timeZone ?? 'UTC';
  const now = deps.now ?? (() => new Date());

  async function referenceIds(): Promise<string[]> {
    const rows = await db
      .selectFrom('session')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('in_reference_set', '=', true)
      .execute();
    return rows.map((r) => r.id);
  }

  /**
   * Re-grades the reference set with every current rubric. With a key the call is once-only (the
   * automatic triggers); without one every call queues a new job (the button). Null when there is
   * nothing to re-grade or the key was already used.
   */
  async function regrade(key?: string): Promise<string | null> {
    const sessionIds = await referenceIds();
    if (sessionIds.length === 0) return null;
    const input = { sessionIds, force: true };
    return key === undefined
      ? deps.grading.enqueueBatch(input)
      : deps.grading.enqueueBatchOnce(input, `reference-regrade:${key}`);
  }

  const scan = createChangeScan({
    db,
    workspaceId,
    skillRepos: deps.skillRepos,
    rubrics: deps.rubrics,
    judges: deps.judges,
    regrade,
    now,
  });

  interface EventRow {
    id: string;
    at: string;
    kind: 'proposal_merged' | 'manual_edit' | 'judge_changed' | 'rubric_changed';
    proposal_id: string | null;
    description: string;
    files: string | null;
    rubric_names: string | null;
  }

  const arr = (stored: unknown): string[] =>
    stored === null ? [] : (fromJson(stored) as string[]);

  async function events(from: Date): Promise<EventRow[]> {
    return db
      .selectFrom('change_event')
      .select(['id', 'at', 'kind', 'proposal_id', 'description', 'files', 'rubric_names'])
      .where('workspace_id', '=', workspaceId)
      .where('at', '>=', from.toISOString())
      .orderBy('at', 'desc')
      .orderBy('id', 'desc')
      .execute();
  }

  const isMarker = (e: EventRow): e is EventRow & { kind: MarkerKind } =>
    e.kind !== 'judge_changed';

  const toMarker = (e: EventRow & { kind: MarkerKind }): TrendMarker => ({
    id: e.id,
    at: e.at,
    kind: e.kind,
    title: e.description,
    proposalId: e.proposal_id,
    files: arr(e.files),
    rubrics: arr(e.rubric_names),
  });

  /** A rubric or judge change starts a new baseline: scores before it were made by another yardstick. */
  function resetsOf(list: readonly EventRow[], current: readonly string[]) {
    return list.flatMap((e) =>
      e.kind === 'rubric_changed'
        ? arr(e.rubric_names).map((rubric) => ({ at: e.at, rubric, reason: e.description }))
        : e.kind === 'judge_changed'
          ? current.map((rubric) => ({ at: e.at, rubric, reason: e.description }))
          : [],
    );
  }

  async function currentRubricNames(): Promise<string[]> {
    return (await deps.rubrics.list()).rubrics.map((r) => r.name);
  }

  async function series(weeks: number, size: BucketSize): Promise<TrendSeries> {
    const at = now();
    const buckets = bucketsFor(at, timeZone, weeks, size);
    const first = buckets[0];
    if (!first) return { buckets: [], markers: [], baselineResets: [] };
    const names = await currentRubricNames();
    const slotSeconds = slotSecondsFor(first.start, at, timeZone);
    const counts = await deps.grading.passCounts({ from: first.start, to: at, slotSeconds });

    // Buckets are sorted; the slot of a row belongs to the last bucket that starts at or before it.
    const starts = buckets.map((b) => b.start.getTime());
    const bucketIndexOf = (ms: number): number => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] ?? 0) <= ms) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const cells = buckets.map(() => new Map<string, Tally>());
    for (const c of counts) {
      const cell = cells[bucketIndexOf(c.slot * slotSeconds * 1000)];
      if (!cell) continue;
      const t = cell.get(c.rubric) ?? { graded: 0, passed: 0 };
      t.graded += c.graded;
      t.passed += c.passed;
      cell.set(c.rubric, t);
    }
    const list = await events(first.start);
    return {
      buckets: buckets.map((b, i) => ({
        start: b.start.toISOString(),
        rubrics: Object.fromEntries(
          names.map((name) => {
            const t = cells[i]?.get(name) ?? { graded: 0, passed: 0 };
            return [name, { passRate: rate(t), graded: t.graded, passed: t.passed }];
          }),
        ),
      })),
      markers: list.filter(isMarker).map(toMarker),
      baselineResets: resetsOf(list, names),
    };
  }

  /**
   * Each change against the sessions that started in the window before it and the window after it
   * (`trends.window_days`, default 7), pooled over the rubrics the change was meant to move (all
   * rubrics when none is known). A reset of a rubric inside either window cuts that rubric's side
   * at the reset, so scores of two yardsticks are never compared. A rubric change itself has no
   * "before": it is reported `too_early`, and its "after" is the new baseline.
   */
  async function changes(): Promise<TrendChange[]> {
    const settings = await deps.settings.get();
    const windowDays = settings['trends.window_days'];
    const windowMs = windowDays * DAY_MS;
    const at = now();
    const all = await events(new Date(at.getTime() - CHANGE_LOG_WEEKS * WEEK_MS - windowMs));
    const current = await currentRubricNames();
    const resets = resetsOf(all, current);
    const shown = all.filter(isMarker).slice(0, MAX_CHANGES);
    const ranges: RangeCount[] = [];
    for (const e of shown) {
      const t = new Date(e.at).getTime();
      const named = arr(e.rubric_names);
      const targets = named.length > 0 ? named : current;
      const beforeFrom = t - windowMs;
      const afterTo = Math.min(t + windowMs, at.getTime());
      // Per rubric, the part of each window that lies on the same side of any reset of it.
      for (const name of targets) {
        const marks = resets
          .filter((r) => r.rubric === name && r.at !== e.at)
          .map((r) => new Date(r.at).getTime());
        const cutBefore = Math.max(beforeFrom, ...marks.filter((m) => m <= t));
        const cutAfter = Math.min(afterTo, ...marks.filter((m) => m > t));
        ranges.push(
          { key: `${e.id}:b`, rubric: name, from: new Date(cutBefore), to: new Date(t) },
          { key: `${e.id}:a`, rubric: name, from: new Date(t), to: new Date(cutAfter) },
        );
      }
    }
    const totals = await deps.grading.passCountsInRanges(ranges);
    const out: TrendChange[] = [];
    for (const e of shown) {
      const none = { graded: 0, passed: 0 };
      const sum = { b: totals.get(`${e.id}:b`) ?? none, a: totals.get(`${e.id}:a`) ?? none };
      const before = e.kind === 'rubric_changed' ? { graded: 0, passed: 0 } : sum.b;
      out.push({
        ...toMarker(e),
        before: { passRate: rate(before), graded: before.graded, window: windowDays },
        after: { passRate: rate(sum.a), graded: sum.a.graded, window: windowDays },
        verdict: verdictOf(before, sum.a, settings['trends.min_graded']),
      });
    }
    return out;
  }

  const handlers: Record<string, JobHandler> = {
    [TRENDS_SCAN_JOB]: {
      concurrency: 1,
      run: async () => {
        await scan.run();
      },
    },
  };
  const schedules: Schedule[] = [
    { name: 'trends-scan', cron: () => Promise.resolve(SCAN_CRON), kind: TRENDS_SCAN_JOB },
  ];

  return {
    handlers,
    schedules,

    /** Header counts and pass-rate cards of the Sessions screen; same counting as the series. */
    async summary(days: number): Promise<TrendSummary> {
      const since = new Date(now().getTime() - days * DAY_MS);
      const sessionsCollected = await deps.ingest.sessions.countStartedSince(since);
      const { sessionsGraded, rubrics } = await deps.grading.trendRubrics(since);
      return { days, sessionsCollected, sessionsGraded, rubrics };
    },

    series,
    changes,

    /** Looks for manual edits, rubric versions and judge changes now (the schedule does it every 15 minutes). */
    scan: () => scan.run(),

    reference: {
      target: REFERENCE_TARGET_SIZE,

      async list(): Promise<ReferenceSession[]> {
        const rows = await db
          .selectFrom('session')
          .select(['id', 'title', 'started_at'])
          .where('workspace_id', '=', workspaceId)
          .where('in_reference_set', '=', true)
          .orderBy('started_at', 'desc')
          .orderBy('id')
          .execute();
        return Promise.all(
          rows.map(async (r) => ({
            id: r.id,
            title: r.title ?? '',
            startedAt: r.started_at,
            grades: (await deps.grading.gradesFor(r.id)).map((g) => ({
              rubric: g.rubric,
              passed: g.passed,
              status: g.status,
            })),
          })),
        );
      },

      async set(sessionId: string, member: boolean): Promise<void> {
        const result = await deps.ingest.setReference(sessionId, member, REFERENCE_TARGET_SIZE);
        if (result === 'not_found') throw new NotFoundError('No such session');
        if (result === 'full')
          throw new ConflictError(
            `The reference set holds ${String(REFERENCE_TARGET_SIZE)} sessions already`,
            'Remove a session from the reference set first.',
          );
      },

      /** Queues a re-grade of the whole set; returns the grading job's id. */
      async regrade(): Promise<string> {
        const id = await regrade();
        if (!id) throw new ConflictError('The reference set is empty', 'Add sessions to it first.');
        return id;
      },
    },
  };
}

export type Trends = ReturnType<typeof createTrends>;

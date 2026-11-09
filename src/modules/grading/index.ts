import { BudgetExceededError, InvalidInputError } from '../../platform/errors.js';
import type { Db } from '../../platform/db/schema.js';
import type { JobQueue } from '../../platform/jobs/queue.js';
import { DeferJob, type JobHandler } from '../../platform/jobs/worker.js';
import type { Schedule } from '../../platform/jobs/scheduler.js';
import type {
  EventFilter,
  GradeCandidate,
  IngestService,
  Page,
  SessionDetail,
  SessionQuery,
  SessionSummary,
  TraceEvent,
} from '../ingest/index.js';
import { parseRubric, serializeRubric, type Rubric, type RubricStore } from '../rubrics/index.js';
import type { SettingsService } from '../settings/index.js';
import { createBudget } from './budget.js';
import {
  gradedSessionCount,
  passCounts,
  passCountsInRanges,
  type PassCountQuery,
  type RangeCount,
} from './pass-counts.js';
import { createCalibration, type CalibrationStats } from './calibration.js';
import type { JudgeProvider } from './judges.js';
import { appliesTo, shouldGrade } from './policy.js';
import { redactionRefusal } from '../ingest/index.js';
import { createGrader, latestGrades, type GradeDetail, type Verdict } from './service.js';

export { createJudgeProvider, type JudgeProvider, type JudgeStatus } from './judges.js';
export { createFakeJudge } from './judge-fake.js';
export {
  createCliInvoker,
  credentialsPresent,
  isolationProblem,
  judgeLogin,
  loginFile,
  parseCliJson,
  spawnRunner,
  usageOf as cliUsageOf,
  type CliRunner,
} from './judge-cli.js';
export { JudgeUnavailableError } from './types.js';
export { JUDGE_MODEL, type Judge, type JudgeRequest, type JudgeResult } from './types.js';
export { condenseTrace, MAX_TRACE_TOKENS } from './condense.js';
export { GATE, gateStats, type CalibrationRow, type CalibrationTable } from './calibration.js';
export {
  costOf,
  estimateCost,
  type Budget,
  type BudgetStatus,
  type Reservation,
} from './budget.js';
export type { Usage } from './types.js';
export type { GradeDetail, Verdict } from './service.js';
export type { PassCount, PassCountQuery, RangeCount } from './pass-counts.js';
export { zonedMidnight } from './budget.js';

export const GRADE_SESSION_JOB = 'grade_session';
export const GRADE_BATCH_JOB = 'grade_batch';
const GRADE_SWEEP_JOB = 'grade_sweep';
/** The sweep reads every rubric from git, so it runs every five minutes, not every minute. */
const SWEEP_CRON = '*/5 * * * *';
/** The automatic trigger looks at sessions that started this recently (about 30 graded sessions a week, ADR-0006). */
const SWEEP_DAYS = 7;
const SWEEP_LIMIT = 200;
const DAY_MS = 86_400_000;
/** The pass-rate goal when a rubric file has no `target` (overview section 9, Trends). */
export const DEFAULT_TARGET = 0.7;
const MAX_DRY_RUN_SESSIONS = 20;
/** A failed batch lists this many errors in its progress; the rest is only counted. */
const MAX_ERRORS_KEPT = 20;

export interface GradingDeps {
  db: Db;
  workspaceId: string;
  userId: string;
  settings: Pick<SettingsService, 'get'>;
  queue: Pick<JobQueue, 'enqueue' | 'setProgress'>;
  ingest: Pick<IngestService, 'sessions' | 'pinSession'>;
  rubrics: RubricStore;
  judges: Pick<JudgeProvider, 'current'>;
  now?: () => Date;
  /** How far back the automatic trigger looks; default 7 days. */
  sweepDays?: number;
  /** IANA time zone of the budget windows; default UTC. */
  timeZone?: string;
}

export interface BatchInput {
  sessionIds: readonly string[];
  rubrics?: readonly string[];
  force: boolean;
}

export interface GradeSelection {
  sessionIds?: readonly string[];
  since?: Date;
  all?: boolean;
  /** Apply the flagged-plus-sample policy and `applies_to`; manual runs grade every rubric. */
  policy: boolean;
}

export interface GradeRunSummary {
  sessions: number;
  graded: number;
  skipped: number;
  /** Over budget: queued again for the next window. */
  deferred: number;
  failed: number;
  errors: string[];
  /** Why work was skipped, with a count per reason ("already graded", "redaction is off", ...). */
  skippedReasons: Record<string, number>;
}

/** A failing grade of a trusted rubric, with what the improver needs to know about its session. */
export interface FailedGrade {
  sessionId: string;
  rubric: string;
  rubricSha: string;
  reason: string;
  evidenceEventIds: string[];
  gradedAt: string;
  sessionTitle: string;
  repoRoot: string | null;
  cwd: string | null;
}

export interface FailedGrades {
  failures: FailedGrade[];
  /** Failing grades of rubrics that have not passed the calibration gate: left out, and reported. */
  untrusted: { rubric: string; failures: number }[];
}

export interface DryRunResult {
  verdicts: (Verdict & { humanPassed: boolean | null; agrees: boolean | null })[];
  skipped: { sessionId: string; reason: string }[];
  usage: { tokens: number; costUsd: number };
}

export function createGrading(deps: GradingDeps) {
  const { db, workspaceId, rubrics } = deps;
  const now = deps.now ?? (() => new Date());
  const budget = createBudget(db, workspaceId, () => deps.settings.get(), deps.timeZone);
  const grader = createGrader({
    db,
    workspaceId,
    userId: deps.userId,
    budget,
    judge: () => deps.judges.current(),
    traceFor: (id, cut) => deps.ingest.sessions.traceFor(id, cut),
    now,
  });
  const calibration = createCalibration({
    db,
    workspaceId,
    userId: deps.userId,
    rubrics,
    sessionExists: async (id) =>
      (await deps.ingest.sessions.gradeCandidates({ ids: [id] })).length > 0,
    pin: (id) => deps.ingest.pinSession(id),
    now,
  });

  async function trustedNames(): Promise<(name: string) => boolean> {
    const { rubrics: all } = await rubrics.list();
    const map = await calibration.trustedByName(all.map((r) => r.name));
    return (name) => map.get(name) ?? false;
  }

  /**
   * Grades marked stale (a re-ingest removed an event they cite) are graded again, whatever the
   * session's age or the sampling policy: they had a grade once. The grade's id is in the key so
   * the finished job of the first grade does not block the new one.
   */
  async function requeueStale(current: readonly Rubric[], model: string): Promise<number> {
    const stale = await db
      .selectFrom('grade')
      .innerJoin('rubric', 'rubric.id', 'grade.rubric_id')
      .select(['grade.id', 'grade.session_id', 'grade.graded_at', 'rubric.name'])
      .where('grade.workspace_id', '=', workspaceId)
      .where('grade.status', '=', 'stale')
      .execute();
    if (stale.length === 0) return 0;
    const sessionIds = [...new Set(stale.map((g) => g.session_id))];
    const redacted = new Set(
      (await deps.ingest.sessions.gradeCandidates({ ids: sessionIds }))
        .filter((c) => redactionRefusal(c.redactionVersion) === null)
        .map((c) => c.id),
    );
    const newer = await db
      .selectFrom('grade')
      .innerJoin('rubric', 'rubric.id', 'grade.rubric_id')
      .select(['grade.session_id', 'grade.graded_at', 'rubric.name'])
      .where('grade.session_id', 'in', sessionIds)
      .where('grade.status', '!=', 'stale')
      .execute();
    let queued = 0;
    for (const g of stale) {
      const rubric = current.find((r) => r.name === g.name);
      const superseded = newer.some(
        (n) => n.session_id === g.session_id && n.name === g.name && n.graded_at > g.graded_at,
      );
      if (!rubric || superseded || !redacted.has(g.session_id)) continue;
      const id = await deps.queue.enqueue({
        workspaceId,
        kind: GRADE_SESSION_JOB,
        payload: { sessionId: g.session_id, rubricName: g.name },
        idempotencyKey: `grade:${g.session_id}:${rubric.version}:${model}:stale:${g.id}`,
      });
      if (id) queued += 1;
    }
    return queued;
  }

  /** Enqueue one `grade_session` job per session and rubric that has no grade yet. */
  async function sweep(): Promise<number> {
    const settings = await deps.settings.get();
    const { rubrics: current } = await rubrics.list();
    if (current.length === 0) return 0;
    const judge = await deps.judges.current();
    const requeued = await requeueStale(current, judge.model);
    const candidates = await deps.ingest.sessions.gradeCandidates({
      since: new Date(now().getTime() - (deps.sweepDays ?? SWEEP_DAYS) * DAY_MS),
      limit: SWEEP_LIMIT,
    });
    // A session stored unredacted or with old rules is never queued; it waits for its re-import.
    const due = candidates.filter(
      (c) => shouldGrade(c, settings) && redactionRefusal(c.redactionVersion) === null,
    );
    if (due.length === 0) return requeued;
    const graded = await db
      .selectFrom('grade')
      .innerJoin('rubric', 'rubric.id', 'grade.rubric_id')
      .select(['grade.session_id', 'rubric.name'])
      .where(
        'grade.session_id',
        'in',
        due.map((c) => c.id),
      )
      .execute();
    const have = new Set(graded.map((g) => `${g.session_id}|${g.name}`));
    let queued = requeued;
    for (const c of due) {
      for (const r of current) {
        if (have.has(`${c.id}|${r.name}`) || !appliesTo(r.appliesTo, c)) continue;
        const id = await deps.queue.enqueue({
          workspaceId,
          kind: GRADE_SESSION_JOB,
          payload: { sessionId: c.id, rubricName: r.name },
          idempotencyKey: `grade:${c.id}:${r.version}:${judge.model}`,
        });
        if (id) queued += 1;
      }
    }
    return queued;
  }

  async function selectCandidates(sel: GradeSelection): Promise<GradeCandidate[]> {
    const { sessions } = deps.ingest;
    const all = sel.sessionIds
      ? await sessions.gradeCandidates({ ids: sel.sessionIds })
      : await sessions.gradeCandidates({ ...(sel.since && { since: sel.since }) });
    if (!sel.policy) return all;
    const settings = await deps.settings.get();
    return all.filter((c) => shouldGrade(c, settings));
  }

  async function runPool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>) {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
          const item = items[next];
          next += 1;
          if (item !== undefined) await fn(item);
        }
      }),
    );
  }

  async function gradeRubrics(
    c: GradeCandidate,
    list: readonly Rubric[],
    opts: { force: boolean; since?: Date },
    count: (o: 'graded' | 'skipped') => void,
  ): Promise<void> {
    for (const rubric of list) {
      const outcome = await grader.gradeOne({
        sessionId: c.id,
        rubric,
        purpose: 'grade',
        force: opts.force,
        ...(opts.since && { skipIfGradedSince: opts.since }),
      });
      count(outcome.kind === 'graded' ? 'graded' : 'skipped');
    }
  }

  const handlers: Record<string, JobHandler> = {
    [GRADE_SESSION_JOB]: {
      concurrency: 2,
      run: async (job) => {
        const { sessionId, rubricName } = job.payload as { sessionId: string; rubricName: string };
        const rubric = await rubrics.get(rubricName);
        if (rubric) await grader.gradeOne({ sessionId, rubric, purpose: 'grade' });
      },
    },
    [GRADE_BATCH_JOB]: {
      concurrency: 1,
      run: async (job) => {
        const p = job.payload as {
          sessionIds: string[];
          rubrics?: string[];
          force: boolean;
          requestedAt: string;
        };
        const { rubrics: current } = await rubrics.list();
        const list = current.filter((r) => !p.rubrics || p.rubrics.includes(r.name));
        const total = p.sessionIds.length * list.length;
        let done = 0;
        const errors: string[] = [];
        const count = (): void => {
          done += 1;
        };
        for (const id of p.sessionIds) {
          const doneBefore = done;
          try {
            const [c] = await deps.ingest.sessions.gradeCandidates({ ids: [id] });
            if (c) {
              // A batch resumed after a budget deferral must not grade again what it already did.
              await gradeRubrics(
                c,
                list,
                { force: p.force, since: new Date(p.requestedAt) },
                count,
              );
            } else done += list.length;
          } catch (e) {
            // The budget is the batch's to wait for; one broken session must not stop the others.
            if (e instanceof DeferJob) throw e;
            errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
            done = doneBefore + list.length;
          }
          await deps.queue.setProgress(job.id, {
            done,
            total,
            ...(errors.length > 0 && {
              failed: errors.length,
              errors: errors.slice(0, MAX_ERRORS_KEPT),
            }),
          });
        }
      },
    },
    [GRADE_SWEEP_JOB]: {
      concurrency: 1,
      run: async () => {
        await sweep();
      },
    },
  };

  const schedules: Schedule[] = [
    { name: 'grade-sweep', cron: () => Promise.resolve(SWEEP_CRON), kind: GRADE_SWEEP_JOB },
  ];

  function enqueueBatchJob(input: BatchInput, idempotencyKey?: string): Promise<string | null> {
    return deps.queue.enqueue({
      workspaceId,
      kind: GRADE_BATCH_JOB,
      payload: {
        sessionIds: [...input.sessionIds],
        ...(input.rubrics && { rubrics: [...input.rubrics] }),
        force: input.force,
        requestedAt: now().toISOString(),
      },
      maxAttempts: 3,
      ...(idempotencyKey && { idempotencyKey }),
    });
  }

  async function sessionDetailGrades(id: string): Promise<GradeDetail[]> {
    return (await latestGrades(db, workspaceId, [id], await trustedNames())).get(id) ?? [];
  }

  return {
    handlers,
    schedules,
    sweep,
    /** The one ledger of all LLM calls; the improver reserves and settles through it too. */
    budget,
    calibration,

    /** Queues a background batch (re-grade, "Grade selected"). Returns the job id. */
    async enqueueBatch(input: BatchInput): Promise<string> {
      const id = await enqueueBatchJob(input);
      if (!id) throw new Error('The grading job was not created');
      return id;
    },

    /** Like `enqueueBatch`, but a second call with the same key is a no-op (returns null). */
    enqueueBatchOnce: (input: BatchInput, idempotencyKey: string): Promise<string | null> =>
      enqueueBatchJob(input, idempotencyKey),

    /**
     * `introspect grade`: runs in the foreground. Work that does not fit the budget is queued
     * for the next window instead of being lost.
     */
    async gradeNow(
      sel: GradeSelection,
      onProgress?: (done: number, total: number) => void,
    ): Promise<GradeRunSummary> {
      const candidates = await selectCandidates(sel);
      const { rubrics: current } = await rubrics.list();
      const summary: GradeRunSummary = {
        sessions: candidates.length,
        graded: 0,
        skipped: 0,
        deferred: 0,
        failed: 0,
        errors: [],
        skippedReasons: {},
      };
      const judge = await deps.judges.current();
      let done = 0;
      await runPool(candidates, 2, async (c) => {
        const list = sel.policy ? current.filter((r) => appliesTo(r.appliesTo, c)) : current;
        for (const rubric of list) {
          try {
            const outcome = await grader.gradeOne({ sessionId: c.id, rubric, purpose: 'grade' });
            if (outcome.kind === 'graded') summary.graded += 1;
            else {
              summary.skipped += 1;
              summary.skippedReasons[outcome.reason] =
                (summary.skippedReasons[outcome.reason] ?? 0) + 1;
            }
          } catch (e) {
            if (e instanceof DeferJob) {
              summary.deferred += 1;
              await deps.queue.enqueue({
                workspaceId,
                kind: GRADE_SESSION_JOB,
                payload: { sessionId: c.id, rubricName: rubric.name },
                idempotencyKey: `grade:${c.id}:${rubric.version}:${judge.model}`,
                runAfter: e.runAfter,
              });
            } else {
              summary.failed += 1;
              summary.errors.push(
                `${c.id} ${rubric.name}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
        }
        done += 1;
        onProgress?.(done, candidates.length);
      });
      return summary;
    },

    /** Grades without persisting (budget-checked). A draft body or threshold is tested as given. */
    async dryRun(
      rubricName: string,
      sessionIds: readonly string[],
      draft: { body?: string | undefined; passThreshold?: number | undefined } = {},
    ): Promise<DryRunResult> {
      if (sessionIds.length === 0 || sessionIds.length > MAX_DRY_RUN_SESSIONS)
        throw new InvalidInputError(`Pick between 1 and ${String(MAX_DRY_RUN_SESSIONS)} sessions`);
      const saved = await rubrics.get(rubricName);
      if (!saved) throw new InvalidInputError(`No rubric named "${rubricName}"`);
      const edited = draft.body !== undefined || draft.passThreshold !== undefined;
      const rubric: Rubric = edited
        ? {
            ...saved,
            ...parseRubric(
              rubricName,
              serializeRubric({
                ...saved,
                body: draft.body ?? saved.body,
                passThreshold: draft.passThreshold ?? saved.passThreshold,
              }),
            ),
            version: 'draft',
          }
        : saved;
      const human = await calibration.labelsFor(rubricName, sessionIds);
      const result: DryRunResult = { verdicts: [], skipped: [], usage: { tokens: 0, costUsd: 0 } };
      for (const sessionId of sessionIds) {
        let outcome;
        try {
          outcome = await grader.gradeOne({ sessionId, rubric, purpose: 'dry_run' });
        } catch (e) {
          if (e instanceof DeferJob) throw new BudgetExceededError(e.message, e.runAfter);
          throw e;
        }
        if (outcome.kind === 'skipped') {
          result.skipped.push({ sessionId, reason: outcome.reason });
          continue;
        }
        const v = outcome.verdict;
        const humanPassed = human.get(sessionId) ?? null;
        result.verdicts.push({
          ...v,
          humanPassed,
          agrees: humanPassed === null || v.passed === null ? null : humanPassed === v.passed,
        });
        result.usage.tokens += v.usage.input + v.usage.cacheWrite + v.usage.output;
        result.usage.costUsd += v.costUsd;
      }
      return result;
    },

    /** Session reads with grades joined in (the ingest module knows nothing of grading). */
    sessions: {
      async list(q: SessionQuery): Promise<Page<SessionSummary>> {
        const page = await deps.ingest.sessions.list(q);
        const grades = await latestGrades(
          db,
          workspaceId,
          page.items.map((s) => s.id),
          await trustedNames(),
        );
        return {
          ...page,
          items: page.items.map((s) => {
            const g = grades.get(s.id) ?? [];
            return {
              ...s,
              // A stale grade is shown but has no verdict until it is graded again.
              grades: g.map((x) => ({
                rubric: x.rubric,
                passed: x.status === 'stale' ? null : x.passed,
                score: x.status === 'stale' ? null : x.score,
              })),
              notGradedReason: g.length > 0 ? null : s.notGradedReason,
            };
          }),
        };
      },

      async get(id: string): Promise<(SessionDetail & { grades: GradeDetail[] }) | null> {
        const detail = await deps.ingest.sessions.get(id);
        return detail ? { ...detail, grades: await sessionDetailGrades(id) } : null;
      },

      async events(
        id: string,
        q: { filter: EventFilter; cursor?: number | undefined; limit: number },
      ): Promise<(Page<TraceEvent> & { total: number }) | null> {
        const evidenceIds =
          q.filter === 'evidence'
            ? (await sessionDetailGrades(id)).flatMap((g) => g.evidenceEventIds)
            : undefined;
        return deps.ingest.sessions.events(id, { ...q, evidenceIds });
      },
    },

    gradesFor: sessionDetailGrades,

    /** Pass rate per rubric over sessions that started since `since` (see `passCounts` for what counts). */
    async trendRubrics(since: Date): Promise<{
      sessionsGraded: number;
      rubrics: { name: string; passRate: number | null; target: number; gradedCount: number }[];
    }> {
      const counts = new Map(
        (await passCounts(db, workspaceId, { from: since })).map((c) => [c.rubric, c]),
      );
      const { rubrics: current } = await rubrics.list();
      return {
        sessionsGraded: await gradedSessionCount(db, workspaceId, since),
        rubrics: current.map((r) => {
          const c = counts.get(r.name);
          return {
            name: r.name,
            passRate: c && c.graded > 0 ? c.passed / c.graded : null,
            target: r.target ?? DEFAULT_TARGET,
            gradedCount: c?.graded ?? 0,
          };
        }),
      };
    },

    /** Pass and graded counts per rubric (and quarter-hour) for the trend series and change windows. */
    passCounts: (q: PassCountQuery) => passCounts(db, workspaceId, q),

    /** Totals for many (rubric, window) pairs in one pass; see `passCountsInRanges`. */
    passCountsInRanges: (ranges: readonly RangeCount[]) =>
      passCountsInRanges(db, workspaceId, ranges),

    /**
     * Failing grades (status ok, passed false, still the newest of their rubric for the session)
     * made since `since`. Rubrics that have not passed the calibration gate are counted apart.
     */
    async failedGradesSince(since: Date): Promise<FailedGrades> {
      const rows = await db
        .selectFrom('grade')
        .innerJoin('session', 'session.id', 'grade.session_id')
        .select(['session.id', 'session.title', 'session.repo_root', 'session.cwd'])
        .distinct()
        .where('grade.workspace_id', '=', workspaceId)
        .where('grade.status', '=', 'ok')
        .where('grade.passed', '=', false)
        .where('grade.graded_at', '>=', since.toISOString())
        .execute();
      const latest = await latestGrades(
        db,
        workspaceId,
        rows.map((r) => r.id),
        await trustedNames(),
      );
      const failures: FailedGrade[] = [];
      const untrusted = new Map<string, number>();
      for (const s of rows) {
        for (const g of latest.get(s.id) ?? []) {
          if (g.status !== 'ok' || g.passed !== false || g.gradedAt < since.toISOString()) continue;
          if (!g.trusted) {
            untrusted.set(g.rubric, (untrusted.get(g.rubric) ?? 0) + 1);
            continue;
          }
          failures.push({
            sessionId: s.id,
            rubric: g.rubric,
            rubricSha: g.rubricSha,
            reason: g.reason,
            evidenceEventIds: g.evidenceEventIds,
            gradedAt: g.gradedAt,
            sessionTitle: s.title ?? '',
            repoRoot: s.repo_root,
            cwd: s.cwd,
          });
        }
      }
      failures.sort(
        (a, b) => a.sessionId.localeCompare(b.sessionId) || a.rubric.localeCompare(b.rubric),
      );
      return {
        failures,
        untrusted: [...untrusted]
          .map(([rubric, n]) => ({ rubric, failures: n }))
          .sort((a, b) => a.rubric.localeCompare(b.rubric)),
      };
    },

    /** Gate stats of every current rubric, for the rubric list. */
    async calibrationStats(): Promise<Map<string, CalibrationStats & { rubricOrdinal: number }>> {
      const { rubrics: current } = await rubrics.list();
      const out = new Map<string, CalibrationStats & { rubricOrdinal: number }>();
      for (const r of current) {
        const t = await calibration.table(r.name);
        if (t) out.set(r.name, t);
      }
      return out;
    },
  };
}

export type Grading = ReturnType<typeof createGrading>;

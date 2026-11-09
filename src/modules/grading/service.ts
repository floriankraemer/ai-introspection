import { newId } from '../../platform/db/ids.js';
import { asBool, fromJson, toJson } from '../../platform/db/json.js';
import { InvalidInputError } from '../../platform/errors.js';
import type { Db } from '../../platform/db/schema.js';
import { DeferJob } from '../../platform/jobs/worker.js';
import { UnredactedSessionError, type RedactedTrace } from '../ingest/index.js';
import type { Rubric } from '../rubrics/index.js';
import { type Budget, estimateCost } from './budget.js';
import { condenseTrace, estimateTokens } from './condense.js';
import { JUDGE_INSTRUCTIONS, MIN_EVIDENCE_EVENTS } from './prompt.js';
import { type Judge, JudgeCallError, type JudgeResult, type Usage } from './types.js';

const TRACE_CUT = { headChars: 2000, tailChars: 1000 } as const;
/**
 * Calls per grade (ADR-0006): a result that fails validation, or an answer that cannot be parsed,
 * is asked for once more. These retries are the grader's own; they never fall back on the job queue.
 */
const MAX_ATTEMPTS = 2;
const SCALE_EPSILON = 1e-9;

/** What a judge run can produce; `stale` is only ever set later, when a re-import removes cited events. */
export type VerdictStatus = 'ok' | 'refused' | 'invalid';
export type GradeStatus = VerdictStatus | 'stale';

/** The estimate for this call is larger than the whole budget, so waiting for a new window cannot help (HTTP 422). */
export class EstimateExceedsBudgetError extends InvalidInputError {
  constructor(reason: string) {
    super(`Not graded: ${reason}`);
    this.name = 'EstimateExceedsBudgetError';
  }
}

/** What one judge run produced, persisted or not. */
export interface Verdict {
  sessionId: string;
  rubric: string;
  rubricVersion: number;
  status: VerdictStatus;
  score: number | null;
  passed: boolean | null;
  reason: string;
  evidenceEventIds: string[];
  /** The model asked for (unique per session and rubric version). */
  judgeModel: string;
  /** The model that answered; differs when the API fell back. */
  answeredModel: string;
  transport: string;
  /** All calls of this grade, retries included. */
  usage: Usage;
  costUsd: number;
}

export type GradeOutcome =
  { kind: 'graded'; verdict: Verdict } | { kind: 'skipped'; reason: string };

export interface GraderDeps {
  db: Db;
  workspaceId: string;
  userId: string;
  budget: Budget;
  judge: () => Promise<Judge>;
  traceFor: (sessionId: string, cut: typeof TRACE_CUT) => Promise<RedactedTrace | null>;
  now?: () => Date;
}

const onScale = (scale: readonly number[], score: number): boolean =>
  scale.some((v) => Math.abs(v - score) < SCALE_EPSILON);

const NO_USAGE: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
});

/** Resolves labels such as `e12` or `[e12]` to event ids; anything not in the trace is dropped. */
function resolveEvidence(refs: readonly string[], labels: Map<string, string>, ids: Set<string>) {
  const out: string[] = [];
  let dropped = 0;
  for (const ref of refs) {
    const label = /e\d+/i.exec(ref)?.[0]?.toLowerCase();
    const id = (label ? labels.get(label) : undefined) ?? (ids.has(ref) ? ref : undefined);
    if (id === undefined) dropped += 1;
    else if (!out.includes(id)) out.push(id);
  }
  return { ids: out, dropped };
}

export function createGrader(deps: GraderDeps) {
  const { db, workspaceId } = deps;
  const now = deps.now ?? (() => new Date());

  /**
   * One session against one rubric (overview 6.2). Throws `DeferJob` when the budget is used up.
   * `persist: false` is a dry run: the call is on the ledger, but no grade row is written.
   */
  async function gradeOne(input: {
    sessionId: string;
    rubric: Rubric;
    purpose: 'grade' | 'dry_run';
    /** Replace an existing grade of the same version and judge model. */
    force?: boolean;
    /** Skip when a grade of this rubric exists that is newer than this time (a resumed batch). */
    skipIfGradedSince?: Date;
  }): Promise<GradeOutcome> {
    const { sessionId, rubric } = input;
    const judge = await deps.judge();
    if (input.purpose === 'grade') {
      // Keyed by the model asked for, not the one that answered, so a fallback does not hide the grade.
      const existing = await db
        .selectFrom('grade')
        .select(['graded_at', 'status'])
        .where('session_id', '=', sessionId)
        .where('rubric_version', '=', rubric.version)
        .where('judge_model', '=', judge.model)
        .executeTakeFirst();
      const since = input.skipIfGradedSince?.toISOString();
      const fresh = existing !== undefined && since !== undefined && existing.graded_at >= since;
      // A stale grade (its evidence is gone after a re-ingest) is due again.
      const settled = existing !== undefined && existing.status !== 'stale';
      if (settled && (!input.force || fresh)) return { kind: 'skipped', reason: 'already graded' };
    }
    let trace: RedactedTrace | null;
    try {
      trace = await deps.traceFor(sessionId, TRACE_CUT);
    } catch (e) {
      if (e instanceof UnredactedSessionError) return { kind: 'skipped', reason: e.message };
      throw e;
    }
    if (!trace) return { kind: 'skipped', reason: 'no such session' };
    if (trace.events.length === 0) return { kind: 'skipped', reason: 'the session has no events' };
    const condensed = condenseTrace(trace);
    const estimatedInput =
      condensed.estimatedTokens + estimateTokens(rubric.body) + estimateTokens(JUDGE_INSTRUCTIONS);
    const needsEvidence = trace.events.length >= MIN_EVIDENCE_EVENTS;

    const eventIds = new Set(trace.events.map((e) => e.id));
    let result: JudgeResult | undefined;
    let callId = '';
    let usage = NO_USAGE;
    let costUsd = 0;
    let evidence = { ids: [] as string[], dropped: 0 };
    let invalid = false;
    let unusable: string | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // Every attempt reserves its estimate first, so the budget is checked again after a retry
      // and parallel grades cannot all pass the same check.
      const reservation = await deps.budget.reserve(
        {
          purpose: input.purpose,
          model: judge.model,
          transport: judge.transport,
          refId: sessionId,
          userId: deps.userId,
        },
        { inputTokens: estimatedInput, usd: estimateCost(judge.model, estimatedInput) },
        now(),
      );
      if (reservation.kind === 'deferred')
        throw new DeferJob(reservation.deferral.runAfter, reservation.deferral.reason);
      if (reservation.kind === 'too_large')
        throw new EstimateExceedsBudgetError(reservation.reason);

      let settled = false;
      try {
        const answer = await (async () =>
          judge.grade({
            rubric: {
              name: rubric.name,
              version: rubric.version,
              scale: rubric.scale,
              body: rubric.body,
            },
            trace: condensed.text,
            eventCount: trace.events.length,
          }))().then(
          (r) => ({ ok: true as const, r }),
          (e: unknown) => ({ ok: false as const, e }),
        );
        if (answer.ok) {
          result = answer.r;
          costUsd += await deps.budget.settle(reservation.id, {
            model: result.model,
            usage: result.usage,
            status: 'ok',
          });
          settled = true;
          usage = addUsage(usage, result.usage);
        } else if (answer.e instanceof JudgeCallError) {
          // The call was answered, so it was paid for even though it gave no verdict.
          costUsd += await deps.budget.settle(reservation.id, {
            model: answer.e.model,
            usage: answer.e.usage,
            status: 'error',
          });
          settled = true;
          usage = addUsage(usage, answer.e.usage);
          callId = reservation.id;
          if (!answer.e.unusable) throw answer.e;
          unusable = answer.e.message;
          result = undefined;
          continue;
        } else throw answer.e;
      } finally {
        // No response at all: nothing was spent, so the reservation must not keep counting.
        if (!settled) await deps.budget.release(reservation.id);
      }
      callId = reservation.id;
      unusable = undefined;
      if (result.kind === 'refused') break;
      evidence = resolveEvidence(result.evidence, condensed.labels, eventIds);
      invalid =
        !onScale(rubric.scale, result.score) || (needsEvidence && evidence.ids.length === 0);
      if (!invalid) break;
    }
    if (evidence.dropped > 0)
      console.warn(
        `grade ${sessionId} ${rubric.name}: dropped ${String(evidence.dropped)} evidence ids that are not in the trace`,
      );

    const base = {
      sessionId,
      rubric: rubric.name,
      rubricVersion: rubric.ordinal,
      judgeModel: judge.model,
      answeredModel: result?.model ?? judge.model,
      transport: judge.transport,
      usage,
      costUsd,
    };
    let verdict: Verdict;
    if (!result) {
      verdict = {
        ...base,
        status: 'invalid',
        score: null,
        passed: null,
        reason: `The judge's answer could not be used (${unusable ?? 'no answer'}) after ${String(MAX_ATTEMPTS)} tries.`,
        evidenceEventIds: [],
      };
    } else if (result.kind === 'refused') {
      verdict = {
        ...base,
        status: 'refused',
        score: null,
        passed: null,
        reason: 'The judge declined to grade this session.',
        evidenceEventIds: [],
      };
    } else if (invalid) {
      verdict = {
        ...base,
        status: 'invalid',
        score: onScale(rubric.scale, result.score) ? result.score : null,
        passed: null,
        reason: result.reason,
        evidenceEventIds: evidence.ids,
      };
    } else {
      verdict = {
        ...base,
        status: 'ok',
        score: result.score,
        // The application decides; the model never does (ADR-0006).
        passed: result.score >= rubric.passThreshold,
        reason: result.reason,
        evidenceEventIds: evidence.ids,
      };
    }
    if (input.purpose === 'grade') await persist(verdict, rubric, callId);
    return { kind: 'graded', verdict };
  }

  /** Unique per (session, rubric version, requested judge model): a re-grade replaces the row. */
  async function persist(v: Verdict, rubric: Rubric, callId: string): Promise<void> {
    await db.transaction().execute(async (tx) => {
      await tx
        .deleteFrom('grade')
        .where('session_id', '=', v.sessionId)
        .where('rubric_version', '=', rubric.version)
        .where('judge_model', '=', v.judgeModel)
        .execute();
      await tx
        .insertInto('grade')
        .values({
          id: newId(),
          workspace_id: workspaceId,
          session_id: v.sessionId,
          rubric_id: rubric.id,
          rubric_version: rubric.version,
          score: v.score,
          passed: v.passed,
          reason: v.reason,
          evidence_event_ids: toJson(v.evidenceEventIds),
          judge_model: v.judgeModel,
          answered_model: v.answeredModel,
          transport: v.transport,
          status: v.status,
          llm_call_id: callId === '' ? null : callId,
          graded_at: now().toISOString(),
        })
        .execute();
    });
  }

  return { gradeOne };
}

export type Grader = ReturnType<typeof createGrader>;

export interface GradeDetail {
  rubric: string;
  /** Ordinal of the rubric version ("v3"). */
  rubricVersion: number;
  /** Git blob SHA of the rubric file the judge saw. */
  rubricSha: string;
  score: number | null;
  passed: boolean | null;
  reason: string;
  evidenceEventIds: string[];
  /** The model asked for. */
  judgeModel: string;
  /** The model that answered; null for grades made before it was recorded. */
  answeredModel: string | null;
  transport: string;
  gradedAt: string;
  status: GradeStatus;
  /** False until the rubric has passed its calibration gate. */
  trusted: boolean;
}

/** Newest grade per rubric name for each session. */
export async function latestGrades(
  db: Db,
  workspaceId: string,
  sessionIds: readonly string[],
  trusted: (rubric: string) => boolean,
): Promise<Map<string, GradeDetail[]>> {
  const out = new Map<string, GradeDetail[]>();
  if (sessionIds.length === 0) return out;
  const rows = await db
    .selectFrom('grade')
    .innerJoin('rubric', 'rubric.id', 'grade.rubric_id')
    .select([
      'grade.session_id',
      'grade.rubric_version',
      'grade.score',
      'grade.passed',
      'grade.reason',
      'grade.evidence_event_ids',
      'grade.judge_model',
      'grade.answered_model',
      'grade.transport',
      'grade.status',
      'grade.graded_at',
      'rubric.name',
      'rubric.ordinal',
    ])
    .where('grade.workspace_id', '=', workspaceId)
    .where('grade.session_id', 'in', [...sessionIds])
    .orderBy('grade.graded_at', 'desc')
    .execute();
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.session_id}|${r.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = out.get(r.session_id) ?? [];
    list.push({
      rubric: r.name,
      rubricVersion: r.ordinal,
      rubricSha: r.rubric_version,
      score: r.score,
      passed: r.passed === null ? null : asBool(r.passed),
      reason: r.reason ?? '',
      evidenceEventIds: r.evidence_event_ids ? (fromJson(r.evidence_event_ids) as string[]) : [],
      judgeModel: r.judge_model,
      answeredModel: r.answered_model,
      transport: r.transport,
      gradedAt: r.graded_at,
      status: r.status,
      trusted: trusted(r.name),
    });
    out.set(r.session_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.rubric.localeCompare(b.rubric));
  return out;
}

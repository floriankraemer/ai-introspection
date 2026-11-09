import { newId } from '../../platform/db/ids.js';
import { asBool, fromJson, toJson } from '../../platform/db/json.js';
import type { Db } from '../../platform/db/schema.js';
import { DeferJob } from '../../platform/jobs/worker.js';
import type { RedactedTrace } from '../ingest/index.js';
import type { Rubric } from '../rubrics/index.js';
import { type Budget, ESTIMATED_OUTPUT_TOKENS, estimateCost } from './budget.js';
import { condenseTrace, estimateTokens } from './condense.js';
import { JUDGE_INSTRUCTIONS } from './prompt.js';
import type { Judge, JudgeResult, Usage } from './types.js';

const TRACE_CUT = { headChars: 2000, tailChars: 1000 } as const;
/** A result that fails validation is asked for once more (ADR-0006). */
const MAX_ATTEMPTS = 2;
const SCALE_EPSILON = 1e-9;

export type GradeStatus = 'ok' | 'refused' | 'invalid';

/** What one judge run produced, persisted or not. */
export interface Verdict {
  sessionId: string;
  rubric: string;
  rubricVersion: number;
  status: GradeStatus;
  score: number | null;
  passed: boolean | null;
  reason: string;
  evidenceEventIds: string[];
  judgeModel: string;
  transport: string;
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
      const existing = await db
        .selectFrom('grade')
        .select('graded_at')
        .where('session_id', '=', sessionId)
        .where('rubric_version', '=', rubric.version)
        .where('judge_model', '=', judge.model)
        .executeTakeFirst();
      const since = input.skipIfGradedSince?.toISOString();
      const fresh = existing !== undefined && since !== undefined && existing.graded_at >= since;
      if (existing && (!input.force || fresh)) return { kind: 'skipped', reason: 'already graded' };
    }
    const trace = await deps.traceFor(sessionId, TRACE_CUT);
    if (!trace) return { kind: 'skipped', reason: 'no such session' };
    if (trace.events.length === 0) return { kind: 'skipped', reason: 'the session has no events' };
    const condensed = condenseTrace(trace);
    const estimatedInput =
      condensed.estimatedTokens + estimateTokens(rubric.body) + estimateTokens(JUDGE_INSTRUCTIONS);
    const deferral = await deps.budget.check(
      {
        tokens: estimatedInput + ESTIMATED_OUTPUT_TOKENS,
        usd: estimateCost(judge.model, estimatedInput),
      },
      now(),
    );
    if (deferral) throw new DeferJob(deferral.runAfter, deferral.reason);

    const eventIds = new Set(trace.events.map((e) => e.id));
    let result: JudgeResult | undefined;
    let callId = '';
    let evidence = { ids: [] as string[], dropped: 0 };
    let invalid = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      result = await judge.grade({
        rubric: {
          name: rubric.name,
          version: rubric.version,
          scale: rubric.scale,
          body: rubric.body,
        },
        trace: condensed.text,
      });
      callId = await deps.budget.record(
        {
          purpose: input.purpose,
          model: result.model,
          transport: judge.transport,
          usage: result.usage,
          refId: sessionId,
          userId: deps.userId,
        },
        now(),
      );
      if (result.kind === 'refused') break;
      evidence = resolveEvidence(result.evidence, condensed.labels, eventIds);
      const failing = result.score < rubric.passThreshold;
      invalid = !onScale(rubric.scale, result.score) || (failing && evidence.ids.length === 0);
      if (!invalid) break;
    }
    if (!result) throw new Error('The judge returned no result');
    if (evidence.dropped > 0)
      console.warn(
        `grade ${sessionId} ${rubric.name}: dropped ${String(evidence.dropped)} evidence ids that are not in the trace`,
      );

    let verdict: Verdict;
    const base = {
      sessionId,
      rubric: rubric.name,
      rubricVersion: rubric.ordinal,
      judgeModel: result.model,
      transport: judge.transport,
      usage: result.usage,
    };
    const costUsd = await costFromLedger(callId);
    if (result.kind === 'refused') {
      verdict = {
        ...base,
        status: 'refused',
        score: null,
        passed: null,
        reason: 'The judge declined to grade this session.',
        evidenceEventIds: [],
        costUsd,
      };
    } else if (invalid) {
      verdict = {
        ...base,
        status: 'invalid',
        score: onScale(rubric.scale, result.score) ? result.score : null,
        passed: null,
        reason: result.reason,
        evidenceEventIds: evidence.ids,
        costUsd,
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
        costUsd,
      };
    }
    if (input.purpose === 'grade') await persist(verdict, rubric, callId);
    return { kind: 'graded', verdict };
  }

  async function costFromLedger(callId: string): Promise<number> {
    const row = await db
      .selectFrom('llm_call')
      .select('cost_estimate')
      .where('id', '=', callId)
      .executeTakeFirst();
    return row?.cost_estimate ?? 0;
  }

  /** Unique per (session, rubric version, judge model): a re-grade replaces the row. */
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
          transport: v.transport,
          status: v.status,
          llm_call_id: callId,
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
  judgeModel: string;
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

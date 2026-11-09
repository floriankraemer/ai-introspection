import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Grading, JudgeProvider } from '../../modules/grading/index.js';
import type { Rubric, RubricStore } from '../../modules/rubrics/index.js';
import type { JobQueue } from '../jobs/queue.js';
import { ApiError, problemResponses } from './problem.js';
import { jobSchema, security, toJobDto } from './schemas.js';

export interface GradingRouteDeps {
  queue: JobQueue;
  grading: Grading;
  rubrics: RubricStore;
  judges: Pick<JudgeProvider, 'test'>;
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const RATE_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

const rubricSummarySchema = z
  .object({
    name: z.string(),
    /** Ordinal of the current version ("v3"). */
    version: z.number().int(),
    /** Git blob SHA of the current file content. */
    sha: z.string(),
    scale: z.array(z.number()),
    passThreshold: z.number(),
    appliesTo: z.string(),
    /** Pass-rate goal from the rubric file; null means the default (0.7). */
    target: z.number().nullable(),
    /** Calibration gate: at least 10 labels and 8 of 10 agreeing. */
    trusted: z.boolean(),
    agreement: z.object({ agree: z.number().int(), total: z.number().int() }),
    labelCount: z.number().int(),
    /** Pass rate of the last 7 days, or null when nothing is graded. */
    passRate: z.number().nullable(),
  })
  .openapi('RubricSummary');

const calibrationRowSchema = z
  .object({
    sessionId: z.uuid(),
    title: z.string(),
    human: z.object({
      passed: z.boolean(),
      score: z.number().nullable(),
      note: z.string().nullable(),
    }),
    judge: z
      .object({
        passed: z.boolean().nullable(),
        score: z.number().nullable(),
        reason: z.string().nullable(),
      })
      .nullable(),
    agrees: z.boolean().nullable(),
  })
  .openapi('CalibrationRow');

const rubricDetailSchema = rubricSummarySchema
  .extend({
    body: z.string(),
    versions: z.array(
      z.object({ sha: z.string(), at: z.string(), message: z.string(), version: z.number().int() }),
    ),
    calibration: z.array(calibrationRowSchema),
  })
  .openapi('RubricDetail');

const calibrationTableSchema = z
  .object({
    rubric: z.string(),
    rubricOrdinal: z.number().int(),
    labelCount: z.number().int(),
    compared: z.number().int(),
    agreed: z.number().int(),
    agreement: z.number().nullable(),
    trusted: z.boolean(),
    required: z.object({ labels: z.number().int(), agreement: z.number() }),
    rows: z.array(calibrationRowSchema),
  })
  .openapi('CalibrationTable');

const verdictSchema = z
  .object({
    sessionId: z.uuid(),
    rubric: z.string(),
    status: z.enum(['ok', 'refused', 'invalid']),
    score: z.number().nullable(),
    passed: z.boolean().nullable(),
    reason: z.string(),
    evidenceEventIds: z.array(z.uuid()),
    judgeModel: z.string(),
    answeredModel: z.string(),
    transport: z.string(),
    humanPassed: z.boolean().nullable(),
    agrees: z.boolean().nullable(),
  })
  .openapi('DryRunVerdict');

const dryRunResultSchema = z
  .object({
    verdicts: z.array(verdictSchema),
    skipped: z.array(z.object({ sessionId: z.uuid(), reason: z.string() })),
    usage: z.object({ tokens: z.number().int(), costUsd: z.number() }),
  })
  .openapi('DryRunResult');

export const gradeDetailSchema = z
  .object({
    rubric: z.string(),
    rubricVersion: z.number().int(),
    rubricSha: z.string(),
    score: z.number().nullable(),
    passed: z.boolean().nullable(),
    reason: z.string(),
    evidenceEventIds: z.array(z.uuid()),
    /** The model asked for. */
    judgeModel: z.string(),
    /** The model that answered; null for grades made before it was recorded. */
    answeredModel: z.string().nullable(),
    transport: z.string(),
    gradedAt: z.iso.datetime(),
    /** `stale`: an event it cites is gone after a re-import; it is queued to be graded again and excluded from pass rates. */
    status: z.enum(['ok', 'refused', 'invalid', 'stale']),
    trusted: z.boolean(),
  })
  .openapi('GradeDetail');

const budgetSchema = z
  .object({
    mode: z.enum(['tokens_day', 'tokens_day_and_usd_month', 'usd_month']),
    tokensToday: z.number().int(),
    tokensPerDay: z.number().int().nullable(),
    usdMonth: z.number(),
    usdPerMonth: z.number().nullable(),
    /** The improver's share of `tokensToday` and `usdMonth` (one ledger, one budget). */
    improver: z.object({ tokensToday: z.number().int(), usdMonth: z.number() }),
    deferredJobs: z.number().int(),
    tokensResetAt: z.iso.datetime(),
    usdResetAt: z.iso.datetime(),
  })
  .openapi('Budget');

const name = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) });
const sessionIdParam = z.object({ id: z.uuid() });

const listRubrics = createRoute({
  method: 'get',
  path: '/v1/rubrics',
  summary: 'Rubrics of the global skills repository, with calibration gate and pass rate',
  security,
  responses: { 200: json(z.array(rubricSummarySchema), 'The rubrics'), ...problemResponses },
});

const getRubric = createRoute({
  method: 'get',
  path: '/v1/rubrics/{name}',
  summary: 'One rubric: body, commit history and calibration table',
  security,
  request: { params: name },
  responses: { 200: json(rubricDetailSchema, 'The rubric'), ...problemResponses },
});

const putRubric = createRoute({
  method: 'put',
  path: '/v1/rubrics/{name}',
  summary: 'Edit the body or threshold: writes the file and commits it in the skills repository',
  security,
  request: {
    params: name,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            body: z.string().min(1).max(50_000).optional(),
            passThreshold: z.number().optional(),
            target: z.number().min(0).max(1).nullable().optional(),
            message: z.string().max(200).optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: { 200: json(rubricDetailSchema, 'The saved rubric'), ...problemResponses },
});

const dryRun = createRoute({
  method: 'post',
  path: '/v1/rubrics/{name}/dry-run',
  summary:
    'Grade sessions with the saved rubric or an unsaved draft; nothing is persisted as a grade',
  security,
  request: {
    params: name,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            sessionIds: z.array(z.uuid()).min(1).max(20),
            body: z.string().min(1).max(50_000).optional(),
            passThreshold: z.number().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: { 200: json(dryRunResultSchema, 'The verdicts'), ...problemResponses },
});

const calibrationTable = createRoute({
  method: 'get',
  path: '/v1/rubrics/{name}/calibration',
  summary: 'Judge against human labels, agreement and the trust gate',
  security,
  request: { params: name },
  responses: { 200: json(calibrationTableSchema, 'The table'), ...problemResponses },
});

const labelBody = z.object({
  sessionId: z.uuid(),
  passed: z.boolean(),
  score: z.number().optional(),
  note: z.string().max(2000).optional(),
});
const labelRoute = (method: 'post' | 'put') =>
  createRoute({
    method,
    path: '/v1/rubrics/{name}/labels',
    summary:
      'Set the human label of a session for this rubric (also "judge was wrong"); the session is pinned',
    security,
    request: {
      params: name,
      body: { content: { 'application/json': { schema: labelBody } }, required: true },
    },
    responses: { 204: { description: 'Saved' }, ...problemResponses },
  });

const gradeSession = createRoute({
  method: 'post',
  path: '/v1/sessions/{id}/grade',
  summary:
    'Re-grade one session with every rubric (replaces the grade of the same version and judge)',
  security,
  request: { params: sessionIdParam },
  responses: { 202: json(jobSchema, 'The grading job'), ...problemResponses },
});

const gradeBatch = createRoute({
  method: 'post',
  path: '/v1/grades/batch',
  summary: 'Grade the selected sessions (skips what is already graded unless `force`)',
  security,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            sessionIds: z.array(z.uuid()).min(1).max(500),
            rubrics: z.array(z.string()).max(50).optional(),
            force: z.boolean().default(false),
          }),
        },
      },
      required: true,
    },
  },
  responses: { 202: json(jobSchema, 'The grading job'), ...problemResponses },
});

const listGrades = createRoute({
  method: 'get',
  path: '/v1/grades',
  summary: 'Newest grade per rubric for a session',
  security,
  request: { query: z.object({ session_id: z.uuid() }) },
  responses: { 200: json(z.array(gradeDetailSchema), 'The grades'), ...problemResponses },
});

const getBudget = createRoute({
  method: 'get',
  path: '/v1/budget',
  summary: 'Judge usage today and this month against the active limits',
  security,
  responses: { 200: json(budgetSchema, 'The budget'), ...problemResponses },
});

export const testJudgeRoute = createRoute({
  method: 'post',
  path: '/v1/judge/test',
  summary: 'Send a tiny real request through the chosen transport',
  security,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            transport: z.enum(['api', 'cli']),
            apiKey: z.string().max(500).optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: json(z.object({ ok: z.boolean(), detail: z.string() }), 'The result'),
    ...problemResponses,
  },
});

export function registerGradingRoutes(
  app: OpenAPIHono,
  { queue, grading, rubrics, judges }: GradingRouteDeps,
): void {
  async function summaries(): Promise<z.infer<typeof rubricSummarySchema>[]> {
    const { rubrics: current } = await rubrics.list();
    const stats = await grading.calibrationStats();
    const rates = await grading.trendRubrics(new Date(Date.now() - RATE_WINDOW_DAYS * DAY_MS));
    return current.map((r) =>
      summary(r, stats.get(r.name), rates.rubrics.find((x) => x.name === r.name)?.passRate ?? null),
    );
  }
  const summary = (
    r: Rubric,
    s: { labelCount: number; compared: number; agreed: number; trusted: boolean } | undefined,
    passRate: number | null,
  ): z.infer<typeof rubricSummarySchema> => ({
    name: r.name,
    version: r.ordinal,
    sha: r.version,
    scale: r.scale,
    passThreshold: r.passThreshold,
    appliesTo: r.appliesTo,
    target: r.target,
    trusted: s?.trusted ?? false,
    agreement: { agree: s?.agreed ?? 0, total: s?.compared ?? 0 },
    labelCount: s?.labelCount ?? 0,
    passRate,
  });
  async function detail(rubricName: string): Promise<z.infer<typeof rubricDetailSchema>> {
    const found = (await summaries()).find((s) => s.name === rubricName);
    const table = await grading.calibration.table(rubricName);
    const rubric = await rubrics.get(rubricName);
    if (!found || !table || !rubric) throw new ApiError(404, 'Not found', 'No such rubric');
    return {
      ...found,
      body: rubric.body,
      versions: (await rubrics.history(rubricName)).map((v) => ({
        sha: v.sha,
        at: v.at,
        message: v.message,
        version: v.ordinal,
      })),
      calibration: table.rows,
    };
  }

  app.openapi(listRubrics, async (c) => c.json(await summaries(), 200));
  app.openapi(getRubric, async (c) => c.json(await detail(c.req.valid('param').name), 200));
  app.openapi(putRubric, async (c) => {
    const { name: rubricName } = c.req.valid('param');
    await rubrics.update(rubricName, c.req.valid('json'));
    return c.json(await detail(rubricName), 200);
  });
  app.openapi(dryRun, async (c) => {
    const { sessionIds, body, passThreshold } = c.req.valid('json');
    const result = await grading.dryRun(c.req.valid('param').name, sessionIds, {
      body,
      passThreshold,
    });
    return c.json(result, 200);
  });
  app.openapi(calibrationTable, async (c) => {
    const table = await grading.calibration.table(c.req.valid('param').name);
    if (!table) throw new ApiError(404, 'Not found', 'No such rubric');
    return c.json(table, 200);
  });
  app.openapi(labelRoute('post'), async (c) => {
    await grading.calibration.setLabel(c.req.valid('param').name, c.req.valid('json'));
    return c.body(null, 204);
  });
  app.openapi(labelRoute('put'), async (c) => {
    await grading.calibration.setLabel(c.req.valid('param').name, c.req.valid('json'));
    return c.body(null, 204);
  });

  app.openapi(gradeSession, async (c) => {
    const { id } = c.req.valid('param');
    if (!(await grading.sessions.get(id))) throw new ApiError(404, 'Not found', 'No such session');
    const job = await queue.get(await grading.enqueueBatch({ sessionIds: [id], force: true }));
    if (!job) throw new ApiError(500, 'Internal server error', 'The grading job vanished');
    return c.json(toJobDto(job), 202);
  });
  app.openapi(gradeBatch, async (c) => {
    const { sessionIds, rubrics: names, force } = c.req.valid('json');
    const id = await grading.enqueueBatch({ sessionIds, ...(names && { rubrics: names }), force });
    const job = await queue.get(id);
    if (!job) throw new ApiError(500, 'Internal server error', 'The grading job vanished');
    return c.json(toJobDto(job), 202);
  });
  app.openapi(listGrades, async (c) =>
    c.json(await grading.gradesFor(c.req.valid('query').session_id), 200),
  );
  app.openapi(getBudget, async (c) => c.json(await grading.budget.status(), 200));
  app.openapi(testJudgeRoute, async (c) => {
    const { transport, apiKey } = c.req.valid('json');
    return c.json(await judges.test(transport, apiKey), 200);
  });
}

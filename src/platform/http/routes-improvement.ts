import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Improvement } from '../../modules/improvement/index.js';
import type { JobQueue } from '../jobs/queue.js';
import { ApiError, problemResponses } from './problem.js';
import { jobSchema, security, toJobDto } from './schemas.js';

export interface ImprovementRouteDeps {
  queue: JobQueue;
  improvement: Improvement;
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const statusSchema = z.enum(['open', 'accepted', 'rejected', 'conflict', 'superseded', 'failed']);

const clusterSchema = z
  .object({
    id: z.string(),
    rubrics: z.array(z.string()),
    summary: z.string(),
    terms: z.array(z.string()),
    sessionCount: z.number().int(),
    reasons: z.array(z.string()),
  })
  .openapi('ProposalCluster');

export const proposalSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid().nullable(),
    title: z.string(),
    status: statusSchema,
    targetRepo: z
      .object({ id: z.uuid(), kind: z.enum(['global', 'project']), path: z.string() })
      .nullable(),
    /** The main file the change touches. */
    targetPath: z.string(),
    files: z.array(z.string()),
    additions: z.number().int(),
    deletions: z.number().int(),
    branch: z.string().nullable(),
    baseSha: z.string().nullable(),
    headSha: z.string().nullable(),
    /** Unified diff (`git diff --binary` format). */
    diff: z.string(),
    rationale: z.string(),
    evidenceSessionIds: z.array(z.uuid()),
    rubricNames: z.array(z.string()),
    cluster: clusterSchema.nullable(),
    targetPaths: z.array(z.string()),
    /** The first rubric of the cluster. */
    rubric: z.string(),
    clusterSize: z.number().int(),
    /** How accepting works for the target repository now (its override, else the setting). */
    acceptMode: z.enum(['merge', 'pr']),
    validation: z.object({ ok: z.boolean(), problems: z.array(z.string()) }),
    /** SHA of the merge commit after a local merge. */
    mergeCommit: z.string().nullable(),
    rejectReason: z.string().nullable(),
    /** Set while a pull request is open (PR accept mode). */
    prUrl: z.string().nullable(),
    /** Rejection reason, or why a failed proposal was refused. */
    decisionNote: z.string().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('Proposal');

const proposalListSchema = z
  .object({
    items: z.array(proposalSchema),
    /** Proposals with the requested status (all when no filter): `?status=open` is the nav badge. */
    total: z.number().int(),
    counts: z.record(statusSchema, z.number().int()),
  })
  .openapi('ProposalList');

const runSchema = z
  .object({
    id: z.uuid(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    status: z.string(),
    clusters: z.number().int(),
    proposalsCreated: z.number().int(),
    proposals: z.number().int(),
    clustersSkipped: z.number().int(),
    untrustedRubrics: z.array(z.string()),
    error: z.string().nullable(),
    summary: z
      .object({
        since: z.iso.datetime(),
        failedGrades: z.number().int(),
        untrustedExcluded: z.array(z.object({ rubric: z.string(), failures: z.number().int() })),
        skippedSessions: z.array(z.object({ sessionId: z.string(), reason: z.string() })),
        clusters: z.array(
          z.object({
            id: z.string(),
            rubric: z.string(),
            summary: z.string(),
            sessionIds: z.array(z.string()),
            target: z.object({
              id: z.string(),
              kind: z.enum(['global', 'project']),
              path: z.string(),
            }),
            outcome: z.enum(['proposed', 'declined', 'failed', 'skipped', 'deferred']),
            detail: z.string(),
            proposalId: z.string().nullable(),
          }),
        ),
      })
      .nullable(),
  })
  .openapi('ImproverRun');

const id = z.object({ id: z.uuid() });

const listProposals = createRoute({
  method: 'get',
  path: '/v1/proposals',
  summary: 'Proposals, newest first; `total` of `?status=open` is the nav badge',
  security,
  request: {
    query: z.object({
      status: statusSchema.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }),
  },
  responses: { 200: json(proposalListSchema, 'The proposals'), ...problemResponses },
});

const getProposal = createRoute({
  method: 'get',
  path: '/v1/proposals/{id}',
  summary: 'One proposal with its diff, rationale and evidence',
  security,
  request: { params: id },
  responses: { 200: json(proposalSchema, 'The proposal'), ...problemResponses },
});

const patchProposal = createRoute({
  method: 'patch',
  path: '/v1/proposals/{id}',
  summary:
    'Edit first: replace the diff. It is validated like an improver diff, must apply to the base commit, and amends the proposal branch',
  security,
  request: {
    params: id,
    body: {
      content: { 'application/json': { schema: z.object({ diff: z.string().min(1) }) } },
      required: true,
    },
  },
  responses: { 200: json(proposalSchema, 'The proposal'), ...problemResponses },
});

const acceptProposal = createRoute({
  method: 'post',
  path: '/v1/proposals/{id}/accept',
  summary:
    'Accept: `git merge --no-ff` into the default branch (merge mode) or push the branch and open a pull request with gh (pr mode). 409 explains what to fix',
  security,
  request: { params: id },
  responses: { 200: json(proposalSchema, 'The proposal after accepting'), ...problemResponses },
});

const rejectProposal = createRoute({
  method: 'post',
  path: '/v1/proposals/{id}/reject',
  summary: 'Reject with a reason; the branch is deleted',
  security,
  request: {
    params: id,
    body: {
      content: {
        'application/json': { schema: z.object({ reason: z.string().trim().min(1).max(2000) }) },
      },
      required: true,
    },
  },
  responses: { 200: json(proposalSchema, 'The proposal'), ...problemResponses },
});

const startRun = createRoute({
  method: 'post',
  path: '/v1/improver/runs',
  summary: 'Queue a manual improver run over the failing grades of the last 24 hours (or `since`)',
  security,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            since: z
              .string()
              .regex(/^\d+[hdw]$/)
              .optional(),
          }),
        },
      },
    },
  },
  responses: { 202: json(jobSchema, 'The queued job'), ...problemResponses },
});

const listRuns = createRoute({
  method: 'get',
  path: '/v1/improver/runs',
  summary: 'Recent improver runs, newest first',
  security,
  responses: {
    200: json(z.array(runSchema), 'The runs, newest first'),
    ...problemResponses,
  },
});

const scheduleRoute = createRoute({
  method: 'get',
  path: '/v1/improver/schedule',
  summary: 'The improver schedule setting and the time of the next scheduled run',
  security,
  responses: {
    200: json(
      z.object({
        mode: z.enum(['daily', 'weekly', 'manual']),
        nextRunAt: z.iso.datetime().nullable(),
      }),
      'The schedule',
    ),
    ...problemResponses,
  },
});

export function registerImprovementRoutes(
  app: OpenAPIHono,
  { queue, improvement }: ImprovementRouteDeps,
): void {
  const { proposals } = improvement;
  app.openapi(listProposals, async (c) => c.json(await proposals.list(c.req.valid('query')), 200));
  app.openapi(getProposal, async (c) => {
    const p = await proposals.get(c.req.valid('param').id);
    if (!p) throw new ApiError(404, 'Not found', 'No such proposal');
    return c.json(p, 200);
  });
  app.openapi(patchProposal, async (c) =>
    c.json(await proposals.edit(c.req.valid('param').id, c.req.valid('json').diff), 200),
  );
  app.openapi(acceptProposal, async (c) =>
    c.json(await proposals.accept(c.req.valid('param').id), 200),
  );
  app.openapi(rejectProposal, async (c) =>
    c.json(await proposals.reject(c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  app.openapi(startRun, async (c) => {
    const body = c.req.valid('json') as { since?: string } | undefined;
    const job = await queue.get(await improvement.enqueueRun(body?.since));
    if (!job) throw new ApiError(500, 'Internal server error', 'The improver job vanished');
    return c.json(toJobDto(job), 202);
  });
  app.openapi(scheduleRoute, async (c) => c.json(await improvement.schedule(), 200));
  app.openapi(listRuns, async (c) => c.json(await improvement.runs(), 200));
}

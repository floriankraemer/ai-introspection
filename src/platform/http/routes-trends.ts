import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Trends } from '../../modules/trends/index.js';
import type { JobQueue } from '../jobs/queue.js';
import { ApiError, problemResponses } from './problem.js';
import { jobSchema, security, toJobDto } from './schemas.js';

export interface TrendsRouteDeps {
  queue: JobQueue;
  trends: Trends;
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const kind = z.enum(['proposal_merged', 'manual_edit', 'rubric_changed']);

const markerShape = {
  id: z.uuid(),
  at: z.iso.datetime(),
  kind,
  /** What changed: the proposal title, the commit subject, or "Rubric x changed to v3". */
  title: z.string(),
  proposalId: z.uuid().nullable(),
  files: z.array(z.string()),
  /** Rubrics the change was meant to move; empty for a manual edit no proposal explains. */
  rubrics: z.array(z.string()),
};

const trendsSchema = z
  .object({
    buckets: z.array(
      z.object({
        /** Start of the day or ISO week (Monday) in the server's time zone, as an instant. */
        start: z.iso.datetime(),
        /** Keyed by rubric name; a bucket without graded sessions has a null pass rate. */
        rubrics: z.record(
          z.string(),
          z.object({
            passRate: z.number().nullable(),
            graded: z.number().int(),
            passed: z.number().int(),
          }),
        ),
      }),
    ),
    markers: z.array(z.object(markerShape)),
    /** Where a rubric or the judge changed: scores before that point are another baseline. */
    baselineResets: z.array(
      z.object({ at: z.iso.datetime(), rubric: z.string(), reason: z.string() }),
    ),
  })
  .openapi('Trends');

const windowSchema = z.object({
  passRate: z.number().nullable(),
  graded: z.number().int(),
  /** Length of the compared window in days. */
  window: z.number().int(),
});

const changeSchema = z
  .object({
    ...markerShape,
    before: windowSchema,
    after: windowSchema,
    /** Two-proportion z-test at 90%; `too_early` until enough sessions were graded after the change. */
    verdict: z.enum(['improved', 'worse', 'no_change', 'too_early']),
  })
  .openapi('TrendChange');

const referenceSchema = z
  .object({
    /** The size the set is capped at. */
    target: z.number().int(),
    items: z.array(
      z.object({
        id: z.uuid(),
        title: z.string(),
        startedAt: z.iso.datetime().nullable(),
        grades: z.array(
          z.object({ rubric: z.string(), passed: z.boolean().nullable(), status: z.string() }),
        ),
      }),
    ),
  })
  .openapi('ReferenceSet');

const sessionId = z.object({ id: z.uuid() });

const getTrends = createRoute({
  method: 'get',
  path: '/v1/trends',
  summary: 'Pass rate per rubric over time, with change markers and baseline resets',
  security,
  request: {
    query: z.object({
      weeks: z.coerce
        .number()
        .int()
        .refine((n) => [4, 12, 26].includes(n), 'weeks is 4, 12 or 26')
        .default(12),
      bucket: z.enum(['week', 'day']).default('week'),
    }),
  },
  responses: { 200: json(trendsSchema, 'The series'), ...problemResponses },
});

const getChanges = createRoute({
  method: 'get',
  path: '/v1/trends/changes',
  summary: 'Change log: each change with the pass rate before and after it',
  security,
  responses: { 200: json(z.array(changeSchema), 'Newest change first'), ...problemResponses },
});

const getReference = createRoute({
  method: 'get',
  path: '/v1/trends/reference',
  summary: 'The reference set: pinned sessions that are re-graded after every change',
  security,
  responses: { 200: json(referenceSchema, 'The members'), ...problemResponses },
});

const regrade = createRoute({
  method: 'post',
  path: '/v1/trends/reference-regrade',
  summary: 'Re-grade the reference set with every current rubric (409 when it is empty)',
  security,
  responses: { 202: json(jobSchema, 'The grading job'), ...problemResponses },
});

const addReference = createRoute({
  method: 'post',
  path: '/v1/sessions/{id}/reference',
  summary: 'Add a session to the reference set (pins it; 409 when the set is full)',
  security,
  request: { params: sessionId },
  responses: { 204: { description: 'Added' }, ...problemResponses },
});

const removeReference = createRoute({
  method: 'delete',
  path: '/v1/sessions/{id}/reference',
  summary: 'Remove a session from the reference set (it stays pinned)',
  security,
  request: { params: sessionId },
  responses: { 204: { description: 'Removed' }, ...problemResponses },
});

export function registerTrendsRoutes(app: OpenAPIHono, { queue, trends }: TrendsRouteDeps): void {
  app.openapi(getTrends, async (c) => {
    const { weeks, bucket } = c.req.valid('query');
    return c.json(await trends.series(weeks, bucket), 200);
  });
  app.openapi(getChanges, async (c) => c.json(await trends.changes(), 200));
  app.openapi(getReference, async (c) =>
    c.json({ target: trends.reference.target, items: await trends.reference.list() }, 200),
  );
  app.openapi(regrade, async (c) => {
    const job = await queue.get(await trends.reference.regrade());
    if (!job) throw new ApiError(500, 'Internal server error', 'The grading job vanished');
    return c.json(toJobDto(job), 202);
  });
  app.openapi(addReference, async (c) => {
    await trends.reference.set(c.req.valid('param').id, true);
    return c.body(null, 204);
  });
  app.openapi(removeReference, async (c) => {
    await trends.reference.set(c.req.valid('param').id, false);
    return c.body(null, 204);
  });
}

import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  settingsPatchSchema,
  settingsSchema,
  type SettingsService,
} from '../../modules/settings/index.js';
import type { JobQueue } from '../jobs/queue.js';
import type { Job } from '../jobs/queue.js';
import { ApiError, problemResponses } from './problem.js';
import { AUTH_PAGE, setTokenCookie, tokenMatches } from './auth.js';

const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;
const security = [{ bearerAuth: [] }];

const jobSchema = z
  .object({
    id: z.uuid(),
    kind: z.string(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'dead', 'deferred']),
    attempts: z.number().int(),
    max_attempts: z.number().int(),
    run_after: z.iso.datetime(),
    last_error: z.string().nullable(),
    created_at: z.iso.datetime(),
    finished_at: z.iso.datetime().nullable(),
  })
  .openapi('Job');

const toJobDto = (j: Job): z.infer<typeof jobSchema> => ({
  id: j.id,
  kind: j.kind,
  status: j.status,
  attempts: j.attempts,
  max_attempts: j.maxAttempts,
  run_after: j.runAfter,
  last_error: j.lastError,
  created_at: j.createdAt,
  finished_at: j.finishedAt,
});

const health = createRoute({
  method: 'get',
  path: '/v1/health',
  summary: 'Liveness probe',
  responses: {
    200: {
      description: 'The server is up',
      content: { 'application/json': { schema: z.object({ status: z.literal('ok') }) } },
    },
  },
});

const createSession = createRoute({
  method: 'post',
  path: '/v1/auth/session',
  summary: 'Exchange the local token for an HttpOnly cookie (used by the /auth page)',
  request: {
    body: {
      content: { 'application/json': { schema: z.object({ token: z.string() }) } },
      required: true,
    },
  },
  responses: {
    204: { description: 'Cookie set' },
    ...problemResponses,
  },
});

const getSettings = createRoute({
  method: 'get',
  path: '/v1/settings',
  summary: 'Runtime settings',
  security,
  responses: {
    200: {
      description: 'Current settings',
      content: { 'application/json': { schema: settingsSchema } },
    },
    401: problemResponses[401],
  },
});

const patchSettings = createRoute({
  method: 'patch',
  path: '/v1/settings',
  summary: 'Update runtime settings (partial, per group)',
  security,
  request: {
    body: { content: { 'application/json': { schema: settingsPatchSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'Settings after the update',
      content: { 'application/json': { schema: settingsSchema } },
    },
    ...problemResponses,
  },
});

const listJobs = createRoute({
  method: 'get',
  path: '/v1/jobs',
  summary: 'Background jobs, newest first',
  security,
  request: {
    query: z.object({
      status: jobSchema.shape.status.optional(),
      cursor: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
    }),
  },
  responses: {
    200: {
      description: 'A page of jobs',
      content: {
        'application/json': {
          schema: z.object({ items: z.array(jobSchema), next_cursor: z.uuid().nullable() }),
        },
      },
    },
    ...problemResponses,
  },
});

const jobId = z.object({ id: z.uuid() });

const getJob = createRoute({
  method: 'get',
  path: '/v1/jobs/{id}',
  summary: 'One job',
  security,
  request: { params: jobId },
  responses: {
    200: { description: 'The job', content: { 'application/json': { schema: jobSchema } } },
    ...problemResponses,
  },
});

const retryJob = createRoute({
  method: 'post',
  path: '/v1/jobs/{id}/retry',
  summary: 'Re-queue a dead job',
  security,
  request: { params: jobId },
  responses: {
    202: {
      description: 'The job is queued again',
      content: { 'application/json': { schema: jobSchema } },
    },
    ...problemResponses,
  },
});

export interface RouteDeps {
  token: string;
  queue: JobQueue;
  settings: SettingsService;
}

/** Thin handlers: parse with zod, call one service, map the result (ADR-0009 rule 5). */
export function registerRoutes(app: OpenAPIHono, { token, queue, settings }: RouteDeps): void {
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
  });

  app.openapi(health, (c) => c.json({ status: 'ok' as const }, 200));

  app.openapi(createSession, (c) => {
    if (!tokenMatches(token, c.req.valid('json').token))
      throw new ApiError(401, 'Unauthorized', 'Invalid token');
    setTokenCookie(c, token);
    return c.body(null, 204);
  });
  app.get('/auth', (c) =>
    c.html(AUTH_PAGE, 200, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }),
  );

  app.openapi(getSettings, async (c) => c.json(await settings.get(), 200));
  app.openapi(patchSettings, async (c) => c.json(await settings.update(c.req.valid('json')), 200));

  app.openapi(listJobs, async (c) => {
    const { status, cursor, limit } = c.req.valid('query');
    const jobs = await queue.list({
      ...(status && { status }),
      ...(cursor && { cursor }),
      limit: limit + 1,
    });
    const page = jobs.slice(0, limit);
    return c.json(
      {
        items: page.map(toJobDto),
        next_cursor: jobs.length > limit ? (page.at(-1)?.id ?? null) : null,
      },
      200,
    );
  });
  app.openapi(getJob, async (c) => {
    const job = await queue.get(c.req.valid('param').id);
    if (!job) throw new ApiError(404, 'Not found', 'No such job');
    return c.json(toJobDto(job), 200);
  });
  app.openapi(retryJob, async (c) => {
    const { id } = c.req.valid('param');
    if (!(await queue.retryDead(id)))
      throw new ApiError(409, 'Conflict', 'Only dead jobs can be retried');
    const job = await queue.get(id);
    if (!job) throw new ApiError(404, 'Not found', 'No such job');
    return c.json(toJobDto(job), 202);
  });
}

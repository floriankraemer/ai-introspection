import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Grading } from '../../modules/grading/index.js';
import type { IngestService } from '../../modules/ingest/index.js';
import type { Trends } from '../../modules/trends/index.js';
import type { JobQueue } from '../jobs/queue.js';
import { ApiError, problemResponses } from './problem.js';
import { gradeDetailSchema } from './routes-grading.js';
import { agentSchema, DEFAULT_PAGE, jobSchema, MAX_PAGE, security, toJobDto } from './schemas.js';

export interface IngestRouteDeps {
  queue: JobQueue;
  ingest: IngestService;
  grading: Grading;
  trends: Trends;
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const s3RemoteSchema = z
  .object({
    bucket: z.string().min(1).max(255),
    prefix: z.string().max(1024).default(''),
    region: z.string().min(1).max(64).optional(),
    endpoint: z.url().optional(),
    forcePathStyle: z.boolean().optional(),
  })
  .openapi('S3Remote');

const personSchema = z.object({ id: z.uuid(), name: z.string() }).openapi('Person');

const sourceSchema = z
  .object({
    id: z.uuid(),
    agent: agentSchema,
    path: z.string(),
    kind: z.enum(['folder', 'intake', 's3']),
    /** Connection settings of an S3 source; never credentials. */
    remote: s3RemoteSchema.nullable(),
    enabled: z.boolean(),
    status: z.enum(['watching', 'polling', 'disabled', 'missing']),
    /** Who pushes to an intake source; null for other kinds. */
    person: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    /** Sessions ingested from this source; they stay when it is removed. */
    sessionCount: z.number().int(),
  })
  .openapi('Source');

const detectedSourceSchema = z
  .object({ agent: agentSchema, path: z.string(), sessionCount: z.number().int() })
  .openapi('DetectedSource');

const sessionSummarySchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    agent: agentSchema,
    repo: z.string().nullable(),
    person: personSchema,
    startedAt: z.iso.datetime(),
    toolErrors: z.number().int(),
    tokensIn: z.number().int(),
    tokensOut: z.number().int(),
    tokensCacheRead: z.number().int(),
    tokensCacheWrite: z.number().int(),
    grades: z.array(
      z.object({
        rubric: z.string(),
        passed: z.boolean().nullable(),
        score: z.number().nullable(),
      }),
    ),
    notGradedReason: z.string().nullable(),
  })
  .openapi('SessionSummary');

const sessionDetailSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    agent: agentSchema,
    repo: z.string().nullable(),
    branch: z.string().nullable(),
    person: personSchema,
    startedAt: z.iso.datetime(),
    durationS: z.number().int(),
    tokensIn: z.number().int(),
    tokensOut: z.number().int(),
    tokensCacheRead: z.number().int(),
    tokensCacheWrite: z.number().int(),
    model: z.string().nullable(),
    outcome: z.object({
      kind: z.enum(['none', 'commit', 'pr_open', 'pr_merged']),
      ref: z.string().nullable(),
      url: z.string().nullable(),
    }),
    eventCount: z.number().int(),
    errorCount: z.number().int(),
    /** Newest grade per rubric. */
    grades: z.array(gradeDetailSchema),
  })
  .openapi('SessionDetail');

const traceEventSchema = z
  .object({
    id: z.uuid(),
    seq: z.number().int(),
    offsetS: z.number().int(),
    kind: z.enum([
      'user',
      'assistant',
      'tool_call',
      'file_op',
      'mcp',
      'skill',
      'system',
      'unknown',
    ]),
    name: z.string().nullable(),
    text: z.string(),
    isError: z.boolean(),
    input: z.string().nullable(),
    output: z.string().nullable(),
    truncated: z.boolean(),
    payloadPurged: z.boolean(),
  })
  .openapi('TraceEvent');

const trendSummarySchema = z
  .object({
    days: z.number().int(),
    sessionsCollected: z.number().int(),
    sessionsGraded: z.number().int(),
    rubrics: z.array(
      z.object({
        name: z.string(),
        passRate: z.number().nullable(),
        target: z.number(),
        gradedCount: z.number().int(),
      }),
    ),
  })
  .openapi('TrendSummary');

const sessionId = z.object({ id: z.uuid() });
const limit = z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE);

const listSessions = createRoute({
  method: 'get',
  path: '/v1/sessions',
  summary: 'Sessions, newest first',
  security,
  request: {
    query: z.object({
      q: z.string().max(200).optional(),
      agent: agentSchema.optional(),
      /** Only sessions of this person (see `GET /v1/people`). */
      person: z.uuid().optional(),
      result: z.enum(['failed_any', 'all', 'not_graded']).optional(),
      cursor: z.string().max(300).optional(),
      /** Only sessions that started at or after this instant. */
      since: z.iso.datetime({ offset: true }).optional(),
      limit,
    }),
  },
  responses: {
    200: json(
      z.object({ items: z.array(sessionSummarySchema), nextCursor: z.string().nullable() }),
      'A page of sessions',
    ),
    ...problemResponses,
  },
});

const listPeople = createRoute({
  method: 'get',
  path: '/v1/people',
  summary: 'People who own at least one session, most sessions first',
  security,
  responses: {
    200: json(
      z.array(personSchema.extend({ sessions: z.number().int() }).openapi('PersonWithSessions')),
      'The people',
    ),
    ...problemResponses,
  },
});

const getSession = createRoute({
  method: 'get',
  path: '/v1/sessions/{id}',
  summary: 'One session',
  security,
  request: { params: sessionId },
  responses: { 200: json(sessionDetailSchema, 'The session'), ...problemResponses },
});

const listEvents = createRoute({
  method: 'get',
  path: '/v1/sessions/{id}/events',
  summary: 'Trace events of a session, in order',
  security,
  request: {
    params: sessionId,
    query: z.object({
      filter: z.enum(['all', 'errors', 'evidence']).default('all'),
      cursor: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
  },
  responses: {
    200: json(
      z.object({
        items: z.array(traceEventSchema),
        nextCursor: z.string().nullable(),
        total: z.number().int(),
      }),
      'A page of events',
    ),
    ...problemResponses,
  },
});

const rawSession = createRoute({
  method: 'get',
  path: '/v1/sessions/{id}/raw',
  summary: 'The unredacted source log of a session (local mode only)',
  security,
  request: { params: sessionId },
  responses: {
    200: { description: 'The JSONL file', content: { 'text/plain': { schema: z.string() } } },
    ...problemResponses,
  },
});

const listSources = createRoute({
  method: 'get',
  path: '/v1/sources',
  summary: 'Registered log sources',
  security,
  responses: { 200: json(z.array(sourceSchema), 'The sources'), ...problemResponses },
});

const detectSources = createRoute({
  method: 'get',
  path: '/v1/sources/detected',
  summary: 'Agent log folders found on this machine or at the container mount points',
  security,
  responses: { 200: json(z.array(detectedSourceSchema), 'Detected folders'), ...problemResponses },
});

const addSource = createRoute({
  method: 'post',
  path: '/v1/sources',
  summary: 'Register a log folder or an S3 bucket (idempotent per agent and location)',
  security,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.union([
            z.object({ agent: agentSchema, path: z.string().min(1) }),
            z.object({ agent: agentSchema, s3: s3RemoteSchema }),
          ]),
        },
      },
      required: true,
    },
  },
  responses: { 200: json(sourceSchema, 'The source'), ...problemResponses },
});

const sourceIdParam = z.object({ id: z.uuid() });

const patchSource = createRoute({
  method: 'patch',
  path: '/v1/sources/{id}',
  summary:
    'Disable or enable a folder or S3 source (a pushed source is switched off by revoking the token)',
  security,
  request: {
    params: sourceIdParam,
    body: {
      content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } },
      required: true,
    },
  },
  responses: { 200: json(sourceSchema, 'The source'), ...problemResponses },
});

const deleteSource = createRoute({
  method: 'delete',
  path: '/v1/sources/{id}',
  summary:
    'Remove a source; its sessions stay, copies of its logs that Introspect made are deleted',
  security,
  request: { params: sourceIdParam },
  responses: { 204: { description: 'Removed' }, ...problemResponses },
});

const startImport = createRoute({
  method: 'post',
  path: '/v1/imports',
  summary: 'Import the history of all enabled sources',
  security,
  responses: { 202: json(jobSchema, 'The import job'), ...problemResponses },
});

const trendSummary = createRoute({
  method: 'get',
  path: '/v1/trends/summary',
  summary: 'Counts and pass rates for the Sessions header (days=0 means all time)',
  security,
  request: { query: z.object({ days: z.coerce.number().int().min(0).max(365).default(7) }) },
  responses: { 200: json(trendSummarySchema, 'The summary'), ...problemResponses },
});

/** Thin handlers: parse with zod, call one module API, map the result (ADR-0009 rule 5). */
export function registerIngestRoutes(
  app: OpenAPIHono,
  { queue, ingest, grading, trends }: IngestRouteDeps,
): void {
  app.openapi(listSessions, async (c) =>
    c.json(await grading.sessions.list(c.req.valid('query')), 200),
  );

  app.openapi(listPeople, async (c) => c.json(await ingest.sessions.people(), 200));

  app.openapi(getSession, async (c) => {
    const session = await grading.sessions.get(c.req.valid('param').id);
    if (!session) throw new ApiError(404, 'Not found', 'No such session');
    return c.json(session, 200);
  });

  app.openapi(listEvents, async (c) => {
    const { filter, cursor, limit: pageSize } = c.req.valid('query');
    const page = await grading.sessions.events(c.req.valid('param').id, {
      filter,
      cursor,
      limit: pageSize,
    });
    if (!page) throw new ApiError(404, 'Not found', 'No such session');
    return c.json(page, 200);
  });

  app.openapi(rawSession, async (c) => {
    // The server only binds to loopback (local mode), so there is no other mode to refuse.
    const path = await ingest.rawFile(c.req.valid('param').id);
    if (
      !path ||
      !(await stat(path).then(
        (s) => s.isFile(),
        () => false,
      ))
    ) {
      throw new ApiError(404, 'Not found', 'The source file of this session is not available');
    }
    const body = Readable.toWeb(createReadStream(path)) as ReadableStream;
    return new Response(body, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline',
      },
    }) as never;
  });

  app.openapi(listSources, async (c) => c.json(await ingest.sources.list(), 200));
  app.openapi(detectSources, async (c) => c.json(await ingest.sources.detect(), 200));
  app.openapi(addSource, async (c) => {
    const body = c.req.valid('json');
    if ('s3' in body) return c.json(await ingest.sources.addS3(body.agent, body.s3), 200);
    return c.json(await ingest.sources.add(body.agent, body.path, { restrict: true }), 200);
  });

  app.openapi(patchSource, async (c) =>
    c.json(
      await ingest.sources.setEnabled(c.req.valid('param').id, c.req.valid('json').enabled),
      200,
    ),
  );
  app.openapi(deleteSource, async (c) => {
    await ingest.sources.remove(c.req.valid('param').id);
    return c.body(null, 204);
  });

  app.openapi(startImport, async (c) => {
    const job = await queue.get(await ingest.startImport());
    if (!job) throw new ApiError(500, 'Internal server error', 'The import job vanished');
    return c.json(toJobDto(job), 202);
  });

  app.openapi(trendSummary, async (c) =>
    c.json(await trends.summary(c.req.valid('query').days), 200),
  );
}

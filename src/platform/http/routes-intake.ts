import { constants } from 'node:buffer';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
  EVENT_KINDS,
  FIELD_CAP_CHARS,
  OUTCOME_KINDS,
  readIntakeBody,
  type Intake,
} from '../../modules/ingest/index.js';
import { PayloadTooLargeError } from '../errors.js';
import { ApiError, problemResponse, problemResponses, problemSchema } from './problem.js';
import { agentSchema, security } from './schemas.js';

export interface IntakeRouteDeps {
  intake: Intake;
  /** Largest body, counted before and after decompression. */
  maxBytes: number;
  /** Most bytes one person's raw logs may take on the server. */
  quotaBytes: number;
}

export interface IntakeEnv {
  Variables: { userId: string };
}

export const MTIME_HEADER = 'x-introspect-mtime';
const META_CHARS = 4096;
/** A pushed session is parsed whole in memory, so its body has a smaller cap than raw logs. */
const SESSION_MAX_BYTES = 32 * 1024 * 1024;
const MAX_PUSHED_EVENTS = 50_000;
/** Session bodies parsed at once; more are answered 503 so parallel pushes cannot exhaust memory. */
const SESSION_PARSE_SLOTS = 2;
const RETRY_AFTER_S = 5;

const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().default(null);
const timestamp = z.iso.datetime({ offset: true });
/** Printable ASCII without spaces: tool-call ids and source record keys. */
const token = z.string().regex(/^[\x21-\x7e]{1,256}$/);
const count = z.number().int().min(0);

const pushedEventSchema = z
  .object({
    seq: count,
    ts: nullable(timestamp),
    kind: z.enum(EVENT_KINDS),
    name: nullable(z.string().max(META_CHARS)),
    input: nullable(z.string().max(FIELD_CAP_CHARS)),
    output: nullable(z.string().max(FIELD_CAP_CHARS)),
    isError: z.boolean().default(false),
    ms: nullable(count),
    truncated: z.boolean().default(false),
    callId: nullable(token),
    sourceKey: nullable(token),
  })
  .openapi('PushedEvent');

export const pushedTraceSchema = z
  .object({
    agent: agentSchema,
    nativeId: z.string().regex(/^[\x21-\x7e]{1,256}$/),
    adapterVersion: z.string().min(1).max(64),
    /** `off` is refused: this route takes redacted sessions only. */
    redactionVersion: z.string().min(1).max(64),
    /** The session is over: signals are computed and it may be graded. */
    ended: z.boolean(),
    session: z.object({
      title: nullable(z.string().max(META_CHARS)),
      cwd: nullable(z.string().max(META_CHARS)),
      repo: nullable(z.string().max(META_CHARS)),
      branch: nullable(z.string().max(META_CHARS)),
      model: nullable(z.string().max(META_CHARS)),
      startedAt: timestamp,
      endedAt: nullable(timestamp),
      tokensIn: count.default(0),
      tokensOut: count.default(0),
      tokensCacheRead: count.default(0),
      tokensCacheWrite: count.default(0),
      outcomeKind: z.enum(OUTCOME_KINDS).default('none'),
      outcomeRef: nullable(z.string().max(META_CHARS)),
      warnings: nullable(
        z
          .object({
            unknown: count,
            malformed: count,
            oversized: count,
            redaction_failed: count,
          })
          .partial(),
      ),
    }),
    events: z
      .array(pushedEventSchema)
      .max(MAX_PUSHED_EVENTS)
      .refine(
        (events) => events.every((e, i) => i === 0 || e.seq > (events[i - 1]?.seq ?? -1)),
        'event seq values must be strictly increasing',
      ),
  })
  .openapi('PushedTrace');

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const intakeProblems = {
  ...problemResponses,
  413: {
    description: 'The body is larger than the configured limit (after decompression)',
    content: { 'application/problem+json': { schema: problemSchema } },
  },
  415: {
    description: 'Unsupported Content-Type or Content-Encoding',
    content: { 'application/problem+json': { schema: problemSchema } },
  },
} as const;
const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: problemSchema } },
});

const encodingHeader = z
  .enum(['gzip', 'identity'])
  .optional()
  .openapi({ description: 'gzip bodies are decompressed while they stream in' });

const health = createRoute({
  method: 'get',
  path: '/v1/health',
  summary: 'Liveness probe',
  responses: { 200: json(z.object({ status: z.literal('ok') }), 'The intake is up') },
});

const logAccepted = z
  .object({ sessionId: z.uuid(), jobQueued: z.boolean() })
  .openapi('IntakeLogAccepted');
const sessionStored = z
  .object({ sessionId: z.uuid(), events: z.number().int() })
  .openapi('IntakeSessionStored');

/** Is the body gzip? Anything but gzip or identity is refused. */
function gzipped(c: Context): boolean {
  const encoding = (c.req.header('content-encoding') ?? 'identity').trim().toLowerCase();
  if (encoding !== 'gzip' && encoding !== 'identity')
    throw new ApiError(415, 'Unsupported media type', 'Content-Encoding must be gzip or identity');
  return encoding === 'gzip';
}

function requireType(c: Context, type: string): void {
  const given = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (given !== type) throw new ApiError(415, 'Unsupported media type', `The body must be ${type}`);
}

/** The request body as a Node stream; refused early when the declared length is already too big. */
function bodyStream(c: Context, maxBytes: number): Readable {
  const length = Number(c.req.header('content-length') ?? 0);
  if (length > maxBytes)
    throw new PayloadTooLargeError(`The body is larger than ${String(maxBytes)} bytes`);
  const body = c.req.raw.body;
  return body ? Readable.fromWeb(body as WebReadableStream<Uint8Array>) : Readable.from([]);
}

function mtimeOf(c: Context): number | undefined {
  const value = c.req.header(MTIME_HEADER);
  if (value === undefined) return undefined;
  if (!/^\d{1,15}$/.test(value))
    throw new ApiError(400, 'Invalid request', `${MTIME_HEADER} must be epoch milliseconds`);
  return Number(value);
}

/**
 * The intake routes (ADR-0012). Bodies are streamed with a byte cap, so neither route is
 * validated by zod-openapi's body parser; the contract is registered for the document only.
 */
export function registerIntakeRoutes(app: OpenAPIHono<IntakeEnv>, deps: IntakeRouteDeps): void {
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'A personal intake token from `introspect intake-token create`',
  });

  app.openapi(health, (c) => c.json({ status: 'ok' as const }, 200));

  app.openAPIRegistry.registerPath({
    method: 'put',
    path: '/v1/intake/logs/{agent}/{path}',
    summary: 'Upload a raw session log; the server redacts it while it ingests',
    description:
      '`path` is the log path below the agent log root and may contain `/` ' +
      '(`<project>/<session>.jsonl` for Claude Code, `YYYY/MM/DD/rollout-….jsonl` for Codex). ' +
      'Re-uploading a grown file ingests only the new lines; the same bytes are a no-op.',
    security,
    request: {
      params: z.object({ agent: agentSchema, path: z.string() }),
      headers: z.object({
        'content-encoding': encodingHeader,
        [MTIME_HEADER]: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .openapi({ description: "The file's last-write time in epoch ms (default: now)" }),
      }),
      body: {
        required: true,
        content: { 'application/x-ndjson': { schema: z.string() } },
      },
    },
    responses: {
      202: json(logAccepted, 'Stored; the ingest is queued'),
      ...intakeProblems,
      507: problem("The server is low on disk space, or the person's storage quota is used up"),
    },
  });
  app.put('/v1/intake/logs/:agent/:path{.+}', async (c) => {
    requireType(c, 'application/x-ndjson');
    const result = await deps.intake.putLog({
      userId: c.get('userId'),
      agent: c.req.param('agent'),
      path: c.req.param('path'),
      gzip: gzipped(c),
      mtimeMs: mtimeOf(c),
      body: bodyStream(c, deps.maxBytes),
      maxBytes: deps.maxBytes,
      quotaBytes: deps.quotaBytes,
    });
    return c.json(result, 202);
  });

  app.openAPIRegistry.registerPath({
    method: 'put',
    path: '/v1/intake/sessions/{id}',
    summary: 'Upsert a session redacted on the client; the server redacts it again',
    description:
      '`id` must be the session id derived from `agent` and `nativeId`. Events are replaced; ' +
      'events with the same `sourceKey` keep their ids, so grades survive a re-push.',
    security,
    request: {
      params: z.object({ id: z.uuid() }),
      headers: z.object({ 'content-encoding': encodingHeader }),
      body: { required: true, content: { 'application/json': { schema: pushedTraceSchema } } },
    },
    responses: {
      200: json(sessionStored, 'Stored'),
      ...intakeProblems,
      503: problem('Too many sessions are being stored at once; retry after `Retry-After` seconds'),
    },
  });
  let parsing = 0;
  app.put('/v1/intake/sessions/:id', async (c) => {
    requireType(c, 'application/json');
    if (parsing >= SESSION_PARSE_SLOTS) {
      c.header('retry-after', String(RETRY_AFTER_S));
      return problemResponse(c, 503, 'Service unavailable', {
        detail: 'Too many sessions are being stored at once; try again shortly',
      });
    }
    parsing += 1;
    try {
      return await putSession(c, c.req.param('id'));
    } finally {
      parsing -= 1;
    }
  });

  async function putSession(c: Context<IntakeEnv>, id: string) {
    // The JSON has to fit in one string as well.
    const max = Math.min(deps.maxBytes, SESSION_MAX_BYTES, constants.MAX_STRING_LENGTH);
    const raw = await readIntakeBody(bodyStream(c, max), gzipped(c), max);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new ApiError(400, 'Invalid request', 'The body is not valid JSON');
    }
    const trace = pushedTraceSchema.safeParse(parsed);
    if (!trace.success) {
      throw new InvalidBodyError(
        trace.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return c.json(await deps.intake.putSession(c.get('userId'), id, trace.data), 200);
  }
}

/** A body that does not match the schema; answered as 400 with one entry per issue, like the main API. */
export class InvalidBodyError extends Error {
  constructor(readonly errors: { path: string; message: string }[]) {
    super('Invalid request');
    this.name = 'InvalidBodyError';
  }
}

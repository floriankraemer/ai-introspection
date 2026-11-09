import { z } from '@hono/zod-openapi';
import type { Job } from '../jobs/queue.js';

export const MAX_PAGE = 200;
export const DEFAULT_PAGE = 50;
export const security = [{ bearerAuth: [] }];

/** JSON is camelCase throughout `/v1`; timestamps are ISO-8601 UTC. */
export const jobSchema = z
  .object({
    id: z.uuid(),
    kind: z.string(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'dead', 'deferred']),
    progress: z
      .object({
        done: z.number().int(),
        total: z.number().int(),
        failed: z.number().int().optional(),
        errors: z.array(z.string()).optional(),
      })
      .nullable(),
    error: z.string().nullable(),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    runAfter: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .openapi('Job');

export const toJobDto = (j: Job): z.infer<typeof jobSchema> => ({
  id: j.id,
  kind: j.kind,
  status: j.status,
  progress: j.progress,
  error: j.lastError,
  attempts: j.attempts,
  maxAttempts: j.maxAttempts,
  runAfter: j.runAfter,
  createdAt: j.createdAt,
  finishedAt: j.finishedAt,
});

export const agentSchema = z.enum(['claude_code', 'codex']).openapi('Agent');

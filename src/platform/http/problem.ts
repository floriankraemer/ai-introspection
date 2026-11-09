import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** RFC 9457 problem details. */
export const problemSchema = z
  .object({
    type: z.string().default('about:blank'),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi('Problem');
export type Problem = z.infer<typeof problemSchema>;

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly title: string,
    detail?: string,
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
  }
}

export function problemResponse(
  c: Context,
  status: ContentfulStatusCode,
  title: string,
  extra: Pick<Problem, 'detail' | 'errors'> = {},
): Response {
  const body: Problem = { type: 'about:blank', title, status, ...extra };
  return c.body(JSON.stringify(body), status, { 'content-type': 'application/problem+json' });
}

/** The error responses every operation can return; spread into `responses`. */
export const problemResponses = {
  400: {
    description: 'Invalid request',
    content: { 'application/problem+json': { schema: problemSchema } },
  },
  401: {
    description: 'Missing or invalid token',
    content: { 'application/problem+json': { schema: problemSchema } },
  },
  404: {
    description: 'Not found',
    content: { 'application/problem+json': { schema: problemSchema } },
  },
  409: {
    description: 'Conflicts with the current state',
    content: { 'application/problem+json': { schema: problemSchema } },
  },
  422: {
    description: 'Well-formed but cannot be applied',
    content: { 'application/problem+json': { schema: problemSchema } },
  },
} as const;

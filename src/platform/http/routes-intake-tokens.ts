import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Db } from '../db/schema.js';
import {
  createIntakeToken,
  listIntakeTokens,
  revokeIntakeTokenById,
} from '../identity/intake-tokens.js';
import { ApiError, problemResponses } from './problem.js';
import { security } from './schemas.js';

export interface IntakeTokenRouteDeps {
  intakeTokens: {
    db: Db;
    /** The intake listener's port; null when intake is off. */
    port: number | null;
  };
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const intakeTokenSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    person: z.string(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .openapi('IntakeToken');

const createdIntakeTokenSchema = intakeTokenSchema
  .extend({ token: z.string().describe('Shown once; only its hash is stored.') })
  .openapi('CreatedIntakeToken');

const listIntakeTokensRoute = createRoute({
  method: 'get',
  path: '/v1/intake-tokens',
  summary: 'Push tokens of other people, and whether the intake listener is on',
  security,
  responses: {
    200: json(
      z.object({
        intake: z.object({ port: z.number().int().nullable() }),
        tokens: z.array(intakeTokenSchema),
      }),
      'Tokens, oldest first; never their secrets',
    ),
    ...problemResponses,
  },
});

const createIntakeTokenRoute = createRoute({
  method: 'post',
  path: '/v1/intake-tokens',
  summary: 'Create a push token; the plaintext is in this response only',
  security,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().trim().min(1).max(64),
            expiresInDays: z.number().int().min(1).max(3650).optional(),
            /** Give an existing person another token instead of refusing the name. */
            samePerson: z.boolean().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    201: json(createdIntakeTokenSchema, 'The token, with its secret'),
    ...problemResponses,
  },
});

const revokeIntakeTokenRoute = createRoute({
  method: 'delete',
  path: '/v1/intake-tokens/{id}',
  summary: 'Revoke a push token',
  security,
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 204: { description: 'Revoked' }, ...problemResponses },
});

export function registerIntakeTokenRoutes(
  app: OpenAPIHono,
  { intakeTokens: { db, port } }: IntakeTokenRouteDeps,
): void {
  app.openapi(listIntakeTokensRoute, async (c) =>
    c.json({ intake: { port }, tokens: await listIntakeTokens(db) }, 200),
  );

  app.openapi(createIntakeTokenRoute, async (c) => {
    const { name, expiresInDays, samePerson } = c.req.valid('json');
    // A taken name throws ConflictError (409).
    const { id, token } = await createIntakeToken(db, name, {
      ...(expiresInDays !== undefined && { expires: `${String(expiresInDays)}d` }),
      ...(samePerson !== undefined && { samePerson }),
    });
    const row = (await listIntakeTokens(db)).find((r) => r.id === id);
    if (!row) throw new ApiError(500, 'Internal server error', 'Created token not found');
    // The plaintext is in this response only; keep it out of every cache.
    c.header('Cache-Control', 'no-store');
    return c.json({ ...row, token }, 201);
  });

  app.openapi(revokeIntakeTokenRoute, async (c) => {
    const { id } = c.req.valid('param');
    if ((await revokeIntakeTokenById(db, id)) === 0)
      throw new ApiError(404, 'Not found', 'No active intake token with this id');
    return c.body(null, 204);
  });
}

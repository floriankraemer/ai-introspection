import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { Db } from '../db/schema.js';
import {
  ConflictError,
  InsufficientStorageError,
  InvalidInputError,
  PayloadTooLargeError,
} from '../errors.js';
import { findIntakeToken } from '../identity/tokens.js';
import { ApiError, problemResponse } from './problem.js';
import {
  InvalidBodyError,
  registerIntakeRoutes,
  type IntakeEnv,
  type IntakeRouteDeps,
} from './routes-intake.js';

export interface IntakeAppDeps extends IntakeRouteDeps {
  db: Db;
  workspaceId: string;
  now?: () => Date;
}

export const INTAKE_OPENAPI_INFO = { title: 'Introspect Intake API', version: '1.0.0' } as const;

/**
 * Personal intake tokens only (hashes in `api_token`). The local admin token is not one of them,
 * so it never works here, and intake tokens never work on the main API.
 */
function intakeAuth(deps: IntakeAppDeps): MiddlewareHandler<IntakeEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const found = await findIntakeToken(deps.db, deps.workspaceId, bearer, deps.now?.());
    if (!found) {
      c.header('www-authenticate', 'Bearer');
      return problemResponse(c, 401, 'Unauthorized', {
        detail: 'A valid intake token is required',
      });
    }
    c.set('userId', found.userId);
    await next();
  };
}

/**
 * The intake listener (ADR-0012): a separate port that other people push sessions to. It serves
 * health, its contract and the intake routes; no SPA, no cookies, nothing of the main API.
 */
export function createIntakeApp(deps: IntakeAppDeps): OpenAPIHono<IntakeEnv> {
  const app = new OpenAPIHono<IntakeEnv>();
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
    }),
  );
  app.use('/v1/intake/*', intakeAuth(deps));
  registerIntakeRoutes(app, deps);
  app.doc31('/v1/openapi.json', { openapi: '3.1.0', info: INTAKE_OPENAPI_INFO });

  app.onError((err, c) => {
    if (err instanceof ApiError)
      return problemResponse(c, err.status, err.title, { detail: err.message });
    if (err instanceof InvalidBodyError)
      return problemResponse(c, 400, 'Invalid request', { errors: err.errors });
    if (err instanceof PayloadTooLargeError)
      return problemResponse(c, 413, 'Payload too large', { detail: err.message });
    if (err instanceof InvalidInputError)
      return problemResponse(c, 422, 'Unprocessable request', {
        detail: err.message,
        problems: [err.message],
      });
    if (err instanceof InsufficientStorageError)
      return problemResponse(c, 507, 'Insufficient storage', { detail: err.message });
    if (err instanceof ConflictError)
      return problemResponse(c, 409, 'Conflict', { detail: err.message });
    console.error(err);
    return problemResponse(c, 500, 'Internal server error');
  });
  app.notFound((c) => problemResponse(c, 404, 'Not found'));
  return app;
}

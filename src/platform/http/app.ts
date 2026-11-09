import { serveStatic } from '@hono/node-server/serve-static';
import { OpenAPIHono } from '@hono/zod-openapi';
import { relative } from 'node:path';
import { localGuard, requireToken } from './auth.js';
import { ConflictError, InvalidInputError } from '../errors.js';
import { ApiError, problemResponse } from './problem.js';
import { registerRoutes, type RouteDeps } from './routes.js';

export interface AppDeps extends RouteDeps {
  /** Built SPA folder. */
  webDir: string;
  port: number;
}

/** Reachable without a token: liveness, the contract, and the token-for-cookie exchange itself. */
const OPEN_PATHS: ReadonlySet<string> = new Set([
  '/v1/health',
  '/v1/openapi.json',
  '/v1/auth/session',
]);

export const OPENAPI_INFO = { title: 'Introspect API', version: '1.0.0' } as const;

/** Hono app: the `/v1` API (OpenAPI 3.1 from zod) plus the built SPA with history fallback to index.html. */
export function createApp(deps: AppDeps): OpenAPIHono {
  // serveStatic resolves its root against the working directory.
  const root = relative(process.cwd(), deps.webDir) || '.';
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return problemResponse(c, 400, 'Invalid request', {
          errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return undefined;
    },
  });

  app.use('*', localGuard(deps.port));
  app.use('/v1/*', requireToken(deps.token, OPEN_PATHS));
  registerRoutes(app, deps);
  app.doc31('/v1/openapi.json', { openapi: '3.1.0', info: OPENAPI_INFO });

  app.onError((err, c) => {
    if (err instanceof ApiError)
      return problemResponse(c, err.status, err.title, { detail: err.message });
    if (err instanceof InvalidInputError)
      return problemResponse(c, 422, 'Unprocessable request', { detail: err.message });
    if (err instanceof ConflictError)
      return problemResponse(c, 409, 'Conflict', { detail: err.message });
    console.error(err);
    return problemResponse(c, 500, 'Internal server error');
  });
  app.all('/v1/*', (c) => problemResponse(c, 404, 'Not found'));
  app.use('*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: 'index.html' }));

  return app;
}

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { relative } from 'node:path';

/** Hono app: `/v1` API plus the built SPA (webDir) with history fallback to index.html. */
export function createApp(webDir: string): Hono {
  // serveStatic resolves its root against the working directory.
  const root = relative(process.cwd(), webDir) || '.';
  const app = new Hono();

  app.get('/v1/health', (c) => c.json({ status: 'ok' as const }));
  app.all('/v1/*', (c) => c.json({ error: 'not_found' }, 404));
  app.use('*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: 'index.html' }));

  return app;
}

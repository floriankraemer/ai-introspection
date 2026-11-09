#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { createApp } from './platform/http/app.js';

const DEFAULT_PORT = 7317;
// Same relative path from src/cli.ts (tsx) and dist/cli.js (built).
const WEB_DIR = fileURLToPath(new URL('../web/dist', import.meta.url));

function startServer(): void {
  const port = Number(process.env.INTROSPECT_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `INTROSPECT_PORT must be a port number, got "${String(process.env.INTROSPECT_PORT)}"`,
    );
  }
  const hostname = process.env.INTROSPECT_HOST ?? '127.0.0.1';
  const server = serve({ fetch: createApp(WEB_DIR).fetch, port, hostname }, (info) => {
    console.log(`introspect listening on http://${info.address}:${String(info.port)}`);
  });
  // Node as PID 1 ignores SIGTERM unless handled; `docker stop` would wait 10 s otherwise.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close(() => {
        process.exit(0);
      });
    });
  }
}

const [command] = process.argv.slice(2);
if (command === 'serve') {
  startServer();
} else {
  console.error('Usage: introspect serve');
  process.exit(1);
}

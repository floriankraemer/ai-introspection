import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { createSettings } from '../modules/settings/index.js';
import type { Config } from './config/index.js';
import { openDatabase } from './db/connection.js';
import { migrateToLatest } from './db/migrate.js';
import { createApp } from './http/app.js';
import { loadOrCreateToken } from './http/auth.js';
import { ensureLocalIdentity, LOCAL_WORKSPACE_ID } from './identity/index.js';
import { createJobQueue } from './jobs/queue.js';
import { createScheduler } from './jobs/scheduler.js';
import { createWorker } from './jobs/worker.js';

// Same relative path from src/platform (tsx) and dist/platform (built).
const WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface RunningServer {
  stop(): Promise<void>;
}

/** Wires database, jobs and HTTP. Modules register job handlers and schedules here as work packages land. */
export async function startServer(config: Config): Promise<RunningServer> {
  const handle = openDatabase(config.databaseUrl);
  try {
    await migrateToLatest(handle);
    await ensureLocalIdentity(handle.db);
  } catch (e) {
    await handle.close();
    throw e;
  }
  const queue = createJobQueue(handle);
  const worker = createWorker({
    queue,
    handlers: {},
    onError: (error, job) => {
      console.error(`job ${job.kind} ${job.id} failed`, error);
    },
  });
  const scheduler = createScheduler({
    handle,
    queue,
    workspaceId: LOCAL_WORKSPACE_ID,
    schedules: [],
  });
  const app = createApp({
    webDir: WEB_DIR,
    port: config.port,
    token: loadOrCreateToken(config.dataDir),
    queue,
    settings: createSettings(handle.db, LOCAL_WORKSPACE_ID),
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`introspect listening on http://${info.address}:${String(info.port)}`);
  });
  worker.start();
  scheduler.start();

  return {
    async stop() {
      scheduler.stop();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        if ('closeIdleConnections' in server) server.closeIdleConnections();
      });
      await worker.stop();
      await handle.close();
    },
  };
}

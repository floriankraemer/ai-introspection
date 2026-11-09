import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { createSkillRepos } from '../modules/improvement/index.js';
import { createIngest } from '../modules/ingest/index.js';
import { createSecretStore, createSettings } from '../modules/settings/index.js';
import { createTrends } from '../modules/trends/index.js';
import type { Config } from './config/index.js';
import { openDatabase } from './db/connection.js';
import { migrateToLatest } from './db/migrate.js';
import { runDoctor, runProgram, type DoctorReport } from './doctor/index.js';
import { createApp } from './http/app.js';
import { loadOrCreateToken } from './http/auth.js';
import { ensureLocalIdentity, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from './identity/index.js';
import { createJobQueue } from './jobs/queue.js';
import { createScheduler } from './jobs/scheduler.js';
import { createWorker } from './jobs/worker.js';

// Same relative path from src/platform (tsx) and dist/platform (built).
const WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

/** Gathers what the doctor checks look at. `dbError` is set when the database is not usable. */
async function doctorReport(
  config: Config,
  handle: ReturnType<typeof openDatabase>,
  settings: ReturnType<typeof createSettings>,
  sources: { list(): Promise<{ agent: string; path: string; enabled: boolean }[]> },
  skillRepos: ReturnType<typeof createSkillRepos>,
): Promise<DoctorReport> {
  let dbError: string | undefined;
  let repos: Awaited<ReturnType<typeof skillRepos.list>> = [];
  let sourceList: Awaited<ReturnType<typeof sources.list>> = [];
  try {
    await handle.db.selectFrom('setting').select('key').limit(1).execute();
    repos = await skillRepos.list();
    sourceList = await sources.list();
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }
  const current = await settings.get().catch(() => undefined);
  return runDoctor({
    dataDir: config.dataDir,
    watchPoll: config.watchPoll,
    db: dbError === undefined ? {} : { error: dbError },
    sources: sourceList,
    repos,
    judge: {
      transport: current?.['judge.transport'] ?? 'api',
      keySet: current?.['judge.api_key_set'] ?? false,
    },
    env: process.env,
    uid: process.getuid?.(),
    run: runProgram,
  });
}

/** `introspect doctor`: opens the database read-mostly (no migration, so "not migrated" is reported). */
export async function runDoctorCommand(config: Config): Promise<DoctorReport> {
  const handle = openDatabase(config.databaseUrl);
  try {
    const settings = createSettings(
      handle.db,
      LOCAL_WORKSPACE_ID,
      createSecretStore(config.dataDir),
    );
    const ingest = createIngest({
      db: handle.db,
      workspaceId: LOCAL_WORKSPACE_ID,
      userId: LOCAL_USER_ID,
      dataDir: config.dataDir,
      settings,
      queue: createJobQueue(handle),
      pollMode: config.watchPoll,
    });
    return await doctorReport(
      config,
      handle,
      settings,
      ingest.sources,
      createSkillRepos(handle.db, LOCAL_WORKSPACE_ID),
    );
  } finally {
    await handle.close();
  }
}

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
  const settings = createSettings(handle.db, LOCAL_WORKSPACE_ID, createSecretStore(config.dataDir));
  const ingest = createIngest({
    db: handle.db,
    workspaceId: LOCAL_WORKSPACE_ID,
    userId: LOCAL_USER_ID,
    dataDir: config.dataDir,
    settings,
    queue,
    pollMode: config.watchPoll,
  });
  const worker = createWorker({
    queue,
    handlers: { ...ingest.handlers },
    onError: (error, job) => {
      console.error(`job ${job.kind} ${job.id} failed`, error);
    },
  });
  const scheduler = createScheduler({
    handle,
    queue,
    workspaceId: LOCAL_WORKSPACE_ID,
    schedules: [...ingest.schedules],
  });
  const skillRepos = createSkillRepos(handle.db, LOCAL_WORKSPACE_ID);
  const app = createApp({
    webDir: WEB_DIR,
    port: config.port,
    token: loadOrCreateToken(config.dataDir),
    queue,
    settings,
    ingest,
    trends: createTrends(ingest),
    skillRepos,
    doctor: () => doctorReport(config, handle, settings, ingest.sources, skillRepos),
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`introspect listening on http://${info.address}:${String(info.port)}`);
  });
  worker.start();
  scheduler.start();
  ingest.startWatching((e) => {
    console.error('file watcher error', e);
  });

  return {
    async stop() {
      scheduler.stop();
      await ingest.stopWatching();
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

/** `introspect import`: a foreground history import without the HTTP server. Registers detected folders when none exist. */
export async function runImportCommand(
  config: Config,
  folder?: { agent: 'claude_code' | 'codex'; path: string },
): Promise<{ files: number; events: number }> {
  const handle = openDatabase(config.databaseUrl);
  try {
    await migrateToLatest(handle);
    await ensureLocalIdentity(handle.db);
    const settings = createSettings(
      handle.db,
      LOCAL_WORKSPACE_ID,
      createSecretStore(config.dataDir),
    );
    const ingest = createIngest({
      db: handle.db,
      workspaceId: LOCAL_WORKSPACE_ID,
      userId: LOCAL_USER_ID,
      dataDir: config.dataDir,
      settings,
      queue: createJobQueue(handle),
      pollMode: config.watchPoll,
    });
    if (folder) await ingest.sources.add(folder.agent, folder.path);
    else if ((await ingest.sources.list()).length === 0) {
      for (const d of await ingest.sources.detect()) await ingest.sources.add(d.agent, d.path);
    }
    return await ingest.importAll((done, total) => {
      process.stderr.write(`\rimported ${String(done)}/${String(total)} files`);
    });
  } finally {
    process.stderr.write('\n');
    await handle.close();
  }
}

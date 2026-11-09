import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { createGrading, createJudgeProvider } from '../modules/grading/index.js';
import {
  createImprovement,
  createImproverProvider,
  createSkillRepos,
  parseSince,
} from '../modules/improvement/index.js';
import { createIngest, createRedactor, loadOrCreateRedactionKey } from '../modules/ingest/index.js';
import { createRubrics } from '../modules/rubrics/index.js';
import { createSecretStore, createSettings } from '../modules/settings/index.js';
import { createTrends, TRENDS_SCAN_JOB } from '../modules/trends/index.js';
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

/** Rubric files are read from git at most this often; UI edits drop the cache at once. */
const RUBRIC_CACHE_MS = 5 * 60_000;

type SecretStoreLike = ReturnType<typeof createSecretStore>;

/** The rubric store, judge provider and grading service, wired the same way for the server and the CLI. */
function buildGrading(
  config: Config,
  handle: ReturnType<typeof openDatabase>,
  settings: ReturnType<typeof createSettings>,
  secrets: SecretStoreLike,
  ingest: ReturnType<typeof createIngest>,
  queue: ReturnType<typeof createJobQueue>,
  skillRepos: ReturnType<typeof createSkillRepos>,
) {
  const rubrics = createRubrics({
    db: handle.db,
    workspaceId: LOCAL_WORKSPACE_ID,
    repoPath: async () => (await skillRepos.getGlobal())?.path ?? null,
    // The sweep runs every 5 minutes; rubric files are read from git at most that often.
    cacheMs: RUBRIC_CACHE_MS,
  });
  const judges = createJudgeProvider({
    secrets,
    env: process.env,
    transport: async () => (await settings.get())['judge.transport'],
    claudeHome: config.claudeHome,
    claudeSeedCredentials: config.claudeSeedCredentials,
    sourcePaths: async () => (await ingest.sources.list()).map((s) => s.path),
    override: config.judgeOverride,
  });
  const grading = createGrading({
    db: handle.db,
    workspaceId: LOCAL_WORKSPACE_ID,
    userId: LOCAL_USER_ID,
    settings,
    queue,
    ingest,
    rubrics,
    judges,
    timeZone: config.timeZone,
  });
  return { rubrics, judges, grading };
}

type GradingParts = ReturnType<typeof buildGrading>;

/** The improver, wired like the judge: same transport setting, same budget ledger, same redaction rules. */
function buildImprovement(
  config: Config,
  handle: ReturnType<typeof openDatabase>,
  settings: ReturnType<typeof createSettings>,
  secrets: SecretStoreLike,
  ingest: ReturnType<typeof createIngest>,
  queue: ReturnType<typeof createJobQueue>,
  skillRepos: ReturnType<typeof createSkillRepos>,
  grading: GradingParts['grading'],
) {
  const redactionKey = loadOrCreateRedactionKey(config.dataDir);
  return createImprovement({
    db: handle.db,
    workspaceId: LOCAL_WORKSPACE_ID,
    userId: LOCAL_USER_ID,
    dataDir: config.dataDir,
    settings,
    queue,
    skillRepos,
    ingest,
    grading,
    improvers: createImproverProvider({
      secrets,
      env: process.env,
      transport: async () => (await settings.get())['judge.transport'],
      claudeHome: config.claudeHome,
      claudeSeedCredentials: config.claudeSeedCredentials,
      sourcePaths: async () => (await ingest.sources.list()).map((s) => s.path),
      override: config.improverOverride,
    }),
    // Diffs and repository files are scanned with the same rules as ingest, built-in and custom (ADR-0007).
    redact: async (text) =>
      createRedactor({
        key: redactionKey,
        customPatterns: (await settings.get())['redaction.custom_patterns'],
      }).redact(text),
    hasSecret: async (text) => {
      const redactor = createRedactor({
        key: redactionKey,
        customPatterns: (await settings.get())['redaction.custom_patterns'],
      });
      const result = redactor.redact(text);
      return result.failed || result.count > 0;
    },
  });
}

/** Gathers what the doctor checks look at. `dbError` is set when the database is not usable. */
async function doctorReport(
  config: Config,
  handle: ReturnType<typeof openDatabase>,
  settings: ReturnType<typeof createSettings>,
  sources: { list(): Promise<{ agent: string; path: string; enabled: boolean }[]> },
  skillRepos: ReturnType<typeof createSkillRepos>,
  parts: Pick<GradingParts, 'rubrics' | 'judges'>,
): Promise<DoctorReport> {
  let dbError: string | undefined;
  let repos: Awaited<ReturnType<typeof skillRepos.list>> = [];
  let sourceList: Awaited<ReturnType<typeof sources.list>> = [];
  let rubricProblems: string[] = [];
  let scanWarnings: { path: string; warning: string }[] = [];
  try {
    await handle.db.selectFrom('setting').select('key').limit(1).execute();
    repos = await skillRepos.list();
    scanWarnings = (await skillRepos.rows()).flatMap((r) =>
      r.scanWarning === null ? [] : [{ path: r.path, warning: r.scanWarning }],
    );
    sourceList = await sources.list();
    rubricProblems = (await parts.rubrics.list()).problems.map((p) => `${p.name}: ${p.error}`);
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }
  const current = await settings.get().catch(() => undefined);
  const status = await parts.judges.status().catch(() => undefined);
  return runDoctor({
    dataDir: config.dataDir,
    watchPoll: config.watchPoll,
    redactionEnabled: current?.['redaction.enabled'] ?? true,
    db: dbError === undefined ? {} : { error: dbError },
    sources: sourceList,
    repos,
    scanWarnings,
    rubricProblems,
    judge: {
      transport: current?.['judge.transport'] ?? 'api',
      keySet: current?.['judge.api_key_set'] ?? false,
      fake: config.judgeOverride === 'fake',
      cli: {
        home: config.claudeHome,
        loginPresent: status?.cliLoginPresent ?? false,
        isolationProblem: status?.isolationProblem ?? null,
      },
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
    const secrets = createSecretStore(config.dataDir);
    const settings = createSettings(handle.db, LOCAL_WORKSPACE_ID, secrets);
    const queue = createJobQueue(handle);
    const ingest = createIngest({
      db: handle.db,
      workspaceId: LOCAL_WORKSPACE_ID,
      userId: LOCAL_USER_ID,
      dataDir: config.dataDir,
      settings,
      queue,
      pollMode: config.watchPoll,
    });
    const skillRepos = createSkillRepos(handle.db, LOCAL_WORKSPACE_ID);
    const parts = buildGrading(config, handle, settings, secrets, ingest, queue, skillRepos);
    return await doctorReport(config, handle, settings, ingest.sources, skillRepos, parts);
  } finally {
    await handle.close();
  }
}

/** `introspect judge-login`: `claude auth login` in the judge's private home. */
export { judgeLogin } from '../modules/grading/index.js';

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
  const secrets = createSecretStore(config.dataDir);
  const settings = createSettings(handle.db, LOCAL_WORKSPACE_ID, secrets);
  const ingest = createIngest({
    db: handle.db,
    workspaceId: LOCAL_WORKSPACE_ID,
    userId: LOCAL_USER_ID,
    dataDir: config.dataDir,
    settings,
    queue,
    pollMode: config.watchPoll,
  });
  const skillRepos = createSkillRepos(handle.db, LOCAL_WORKSPACE_ID);
  const { rubrics, judges, grading } = buildGrading(
    config,
    handle,
    settings,
    secrets,
    ingest,
    queue,
    skillRepos,
  );
  const improvement = buildImprovement(
    config,
    handle,
    settings,
    secrets,
    ingest,
    queue,
    skillRepos,
    grading,
  );
  const trends = createTrends({
    db: handle.db,
    workspaceId: LOCAL_WORKSPACE_ID,
    settings,
    ingest,
    grading,
    rubrics,
    judges,
    skillRepos,
    timeZone: config.timeZone,
  });
  // A judge switch gets the time it happened, not the time of the next scan.
  settings.onUpdate(async (keys) => {
    if (keys.some((k) => k.startsWith('judge.'))) await trends.noteJudge();
  });
  const worker = createWorker({
    queue,
    handlers: {
      ...ingest.handlers,
      ...grading.handlers,
      ...improvement.handlers,
      ...trends.handlers,
    },
    onError: (error, job) => {
      console.error(`job ${job.kind} ${job.id} failed`, error);
    },
  });
  const scheduler = createScheduler({
    handle,
    queue,
    workspaceId: LOCAL_WORKSPACE_ID,
    schedules: [
      ...ingest.schedules,
      ...grading.schedules,
      ...improvement.schedules,
      ...trends.schedules,
    ],
  });
  const app = createApp({
    webDir: WEB_DIR,
    port: config.port,
    token: loadOrCreateToken(config.dataDir),
    queue,
    settings,
    ingest,
    grading,
    improvement,
    rubrics,
    judges,
    trends,
    skillRepos,
    doctor: () =>
      doctorReport(config, handle, settings, ingest.sources, skillRepos, { rubrics, judges }),
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`introspect listening on http://${info.address}:${String(info.port)}`);
  });
  // A crash can leave worktrees and branches behind; clear them before any job can use them.
  await improvement.sweep().catch((e: unknown) => {
    console.error('improver housekeeping failed', e);
  });
  // Remember where each skills repository stands now, so a commit made after this start is a manual edit.
  await queue.enqueue({
    workspaceId: LOCAL_WORKSPACE_ID,
    kind: TRENDS_SCAN_JOB,
    idempotencyKey: `trends-scan:start:${new Date().toISOString()}`,
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

export interface GradeCommandOptions {
  sessionId?: string | undefined;
  since?: Date | undefined;
  all?: boolean | undefined;
  /** Respect the flagged-plus-sample policy and `applies_to`; manual runs grade every rubric. */
  policy: boolean;
}

/** `introspect grade`: grades in the foreground, with the judge the settings select. */
export async function runGradeCommand(
  config: Config,
  opts: GradeCommandOptions,
): Promise<Awaited<ReturnType<ReturnType<typeof createGrading>['gradeNow']>>> {
  const handle = openDatabase(config.databaseUrl);
  try {
    await migrateToLatest(handle);
    await ensureLocalIdentity(handle.db);
    const secrets = createSecretStore(config.dataDir);
    const settings = createSettings(handle.db, LOCAL_WORKSPACE_ID, secrets);
    const queue = createJobQueue(handle);
    const ingest = createIngest({
      db: handle.db,
      workspaceId: LOCAL_WORKSPACE_ID,
      userId: LOCAL_USER_ID,
      dataDir: config.dataDir,
      settings,
      queue,
      pollMode: config.watchPoll,
    });
    const skillRepos = createSkillRepos(handle.db, LOCAL_WORKSPACE_ID);
    const { rubrics, grading } = buildGrading(
      config,
      handle,
      settings,
      secrets,
      ingest,
      queue,
      skillRepos,
    );
    if ((await rubrics.list()).rubrics.length === 0)
      throw new Error(
        'No rubrics found. Set the global skills repository and add the starter rubrics first.',
      );
    return await grading.gradeNow(
      {
        ...(opts.sessionId && { sessionIds: [opts.sessionId] }),
        ...(opts.since && { since: opts.since }),
        ...(opts.all && { all: true }),
        policy: opts.policy,
      },
      (done, total) => {
        process.stderr.write(`\rgraded ${String(done)}/${String(total)} sessions`);
      },
    );
  } finally {
    process.stderr.write('\n');
    await handle.close();
  }
}

export interface ImproveCommandOptions {
  /** `24h`, `7d` or `2w`; default 24 hours. */
  since: string;
  /** Run in the foreground; otherwise queue a job for the running server. */
  now: boolean;
}

/** `introspect improve`: a foreground run with `--now`, else a queued job for the server. */
export async function runImproveCommand(
  config: Config,
  opts: ImproveCommandOptions,
): Promise<{ queued: string } | Awaited<ReturnType<ReturnType<typeof createImprovement>['run']>>> {
  const handle = openDatabase(config.databaseUrl);
  try {
    await migrateToLatest(handle);
    await ensureLocalIdentity(handle.db);
    const secrets = createSecretStore(config.dataDir);
    const settings = createSettings(handle.db, LOCAL_WORKSPACE_ID, secrets);
    const queue = createJobQueue(handle);
    const ingest = createIngest({
      db: handle.db,
      workspaceId: LOCAL_WORKSPACE_ID,
      userId: LOCAL_USER_ID,
      dataDir: config.dataDir,
      settings,
      queue,
      pollMode: config.watchPoll,
    });
    const skillRepos = createSkillRepos(handle.db, LOCAL_WORKSPACE_ID);
    const { grading } = buildGrading(config, handle, settings, secrets, ingest, queue, skillRepos);
    const improvement = buildImprovement(
      config,
      handle,
      settings,
      secrets,
      ingest,
      queue,
      skillRepos,
      grading,
    );
    if (!opts.now) return { queued: await improvement.enqueueRun(opts.since) };
    return await improvement.run(parseSince(opts.since));
  } finally {
    await handle.close();
  }
}

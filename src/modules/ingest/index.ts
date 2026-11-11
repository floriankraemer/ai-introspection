import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { DEFAULT_INTAKE_MAX_MB } from '../../platform/config/index.js';
import { InvalidInputError, NotFoundError } from '../../platform/errors.js';
import type { Db } from '../../platform/db/schema.js';
import type { JobHandler } from '../../platform/jobs/worker.js';
import type { Schedule } from '../../platform/jobs/scheduler.js';
import type { JobQueue } from '../../platform/jobs/queue.js';
import type { SettingsService } from '../settings/index.js';
import { finalizeSession } from './finalize.js';
import { createIntake, INTAKE_DIR } from './intake.js';
import { adapterFor } from './adapters/index.js';
import { ingestFile, SESSION_IDLE_MS, withLock, type PipelineDeps } from './pipeline.js';
import { loadOrCreateRedactionKey, REDACTION_VERSION } from './redaction.js';
import {
  purgeFinishedJobs,
  purgePayloads,
  purgeRawLogs,
  pinSession,
  setReference,
} from './retention.js';
import { createSessionQueries } from './sessions.js';
import {
  createSources,
  defaultSourceRoots,
  detectSources,
  listSessionFiles,
  type SourceDto,
} from './sources.js';
import {
  checkEndpoint,
  createS3Api,
  normalizePrefix,
  probeS3,
  syncS3Source,
  type S3Api,
  type S3Remote,
} from './s3.js';
import { createWatcher, type SourceWatcher } from './watcher.js';
import type { Agent } from './types.js';

export type { GradeCandidate, RedactedTrace, TraceRecord } from './types.js';

export type { Agent, EventKind } from './types.js';
export {
  diagnoseS3,
  probeS3,
  createS3Api,
  type S3Remote,
  type S3Api,
  type S3Diagnosis,
} from './s3.js';
export type { SourceDto, SourceStatus, DetectedSource } from './sources.js';
export type {
  EventFilter,
  Page,
  SessionDetail,
  SessionQuery,
  SessionResultFilter,
  SessionSummary,
  TraceEvent,
} from './sessions.js';
export {
  createRedactor,
  loadOrCreateRedactionKey,
  REDACTION_VERSION,
  redactionRefusal,
  type Redactor,
} from './redaction.js';
export { UnredactedSessionError } from './sessions.js';
export { FIELD_CAP_CHARS } from './pipeline.js';
export { runPush, type PushOptions, type PushSummary } from './push.js';
export {
  EVENT_KINDS,
  OUTCOME_KINDS,
  readIntakeBody,
  type Intake,
  type PushedEvent,
  type PushedTrace,
  type RawLogUpload,
} from './intake.js';

export const IMPORT_JOB = 'import_history';
export const INGEST_FILE_JOB = 'ingest_file';
const RECONCILE_JOB = 'reconcile_sources';
const PURGE_JOB = 'purge_payloads';
const S3_SYNC_JOB = 's3_sync';
const WATCH_DEBOUNCE_MS = 2000;
/** A dead ingest job blocks its key (same size and mtime); after this long reconcile may try the file again. */
const DEAD_INGEST_RETRY_MS = 3600_000;
const PROGRESS_INTERVAL_MS = 1000;
const DAY_MS = 86_400_000;
const S3_DIR = 's3';

export interface IngestDeps {
  db: Db;
  workspaceId: string;
  userId: string;
  dataDir: string;
  settings: Pick<SettingsService, 'get'>;
  queue: Pick<JobQueue, 'enqueue' | 'setProgress'>;
  /** Polling instead of inotify: containers, network and `/mnt/c` mounts. */
  pollMode: boolean;
  /** Folders the API may register sources under; defaults to the mount roots and a native home. */
  sourceRoots?: readonly string[];
  /** S3 access; tests pass a stub. Defaults to the AWS SDK with the standard credential chain. */
  s3Api?: (remote: S3Remote) => S3Api;
  /** Largest S3 object fetched (`config.logMaxBytes`); defaults to the config default. */
  logMaxBytes?: number;
  /** `INTROSPECT_S3_ALLOW_HTTP=1`: plain-http S3 endpoints on other hosts are allowed. */
  s3AllowHttp?: boolean;
  now?: () => Date;
}

type Progress = (done: number, total: number) => Promise<void> | void;

export function createIngest(deps: IngestDeps) {
  const { db, workspaceId } = deps;
  const now = deps.now ?? (() => new Date());
  const pipeline: PipelineDeps = {
    db,
    workspaceId,
    userId: deps.userId,
    redactionKey: loadOrCreateRedactionKey(deps.dataDir),
    settings: deps.settings,
    now,
  };
  const sources = createSources(db, workspaceId, deps.userId, deps.pollMode, now, {
    roots: deps.sourceRoots ?? defaultSourceRoots(),
    dataDir: deps.dataDir,
  });
  const sessions = createSessionQueries(db, workspaceId);

  type EnabledSource = Awaited<ReturnType<typeof sources.enabledRows>>[number];

  async function cursorsOf(
    sourceId: string,
  ): Promise<Map<string, { size: number; mtimeMs: number }>> {
    const rows = await db
      .selectFrom('ingest_cursor')
      .select(['file_path', 'size', 'mtime_ms'])
      .where('source_id', '=', sourceId)
      .execute();
    return new Map(rows.map((r) => [r.file_path, { size: r.size, mtimeMs: r.mtime_ms }]));
  }

  /**
   * Files that need work: known files whose size or mtime moved, and new files touched after the
   * source was registered. Older files with no cursor wait for an explicit history import.
   */
  function isDue(
    source: EnabledSource,
    st: { size: number; mtimeMs: number },
    cursor: { size: number; mtimeMs: number } | undefined,
  ): boolean {
    if (cursor) return cursor.size !== st.size || cursor.mtimeMs !== Math.floor(st.mtimeMs);
    return st.mtimeMs >= Date.parse(source.createdAt);
  }

  async function enqueueIngest(
    source: EnabledSource,
    path: string,
    st: { size: number; mtimeMs: number },
  ): Promise<void> {
    // State lives in the key: the same size and mtime means the same work.
    const idempotencyKey = `${INGEST_FILE_JOB}:${source.id}:${path}:${String(st.size)}:${String(Math.floor(st.mtimeMs))}`;
    // The key would also keep a dead job's work from ever being retried; clear it once it is old enough.
    await db
      .deleteFrom('job')
      .where('idempotency_key', '=', idempotencyKey)
      .where('status', '=', 'dead')
      .where('finished_at', '<', new Date(now().getTime() - DEAD_INGEST_RETRY_MS).toISOString())
      .execute();
    await deps.queue.enqueue({
      workspaceId,
      kind: INGEST_FILE_JOB,
      payload: { sourceId: source.id, path },
      idempotencyKey,
    });
  }

  const s3ApiFor = deps.s3Api ?? createS3Api;
  /** The folders that hold Introspect's own copies of raw logs; retention deletes old files there. */
  const rawLogRoots = [join(deps.dataDir, INTAKE_DIR), join(deps.dataDir, S3_DIR)];

  /** Mirrors every enabled S3 source into its cache folder and queues the ingest of what changed. */
  async function syncS3(): Promise<number> {
    // The s3_sync job, a history import and a new source can all sync at once; one at a time.
    return withLock(S3_SYNC_JOB, syncS3Now);
  }

  async function syncS3Now(): Promise<number> {
    let downloaded = 0;
    const failures: string[] = [];
    const retentionDays = (await deps.settings.get())['retention.days'];
    const notBefore = new Date(now().getTime() - retentionDays * DAY_MS);
    for (const source of await sources.enabledRows()) {
      if (source.kind !== 's3' || !source.remote) continue;
      try {
        const result = await syncS3Source({
          api: s3ApiFor(source.remote),
          remote: source.remote,
          agent: source.agent,
          dir: source.path,
          maxBytes: deps.logMaxBytes ?? DEFAULT_INTAKE_MAX_MB * 1024 * 1024,
          notBefore,
          onFile: async (path) => {
            const st = await stat(path);
            await enqueueIngest(source, path, st);
          },
        });
        downloaded += result.downloaded;
        if (result.rejected.length > 0)
          failures.push(
            `s3://${source.remote.bucket}: ignored keys outside the prefix folder: ${result.rejected.join(', ')}`,
          );
        if (result.tooLarge.length > 0)
          failures.push(
            `s3://${source.remote.bucket}: skipped objects larger than INTROSPECT_INTAKE_MAX_MB: ${result.tooLarge.join(', ')}`,
          );
      } catch (e) {
        failures.push(
          `s3://${source.remote.bucket}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    // One broken bucket must not stop the others, but the job still fails so it shows up.
    if (failures.length > 0) throw new Error(`S3 sync: ${failures.join('; ')}`);
    return downloaded;
  }

  /** The 60 s safety net (ADR-0005): catches events missed after sleep or on mounts without notifications. */
  async function reconcile(): Promise<number> {
    let queued = 0;
    for (const source of await sources.enabledRows()) {
      const cursors = await cursorsOf(source.id);
      for await (const path of listSessionFiles(source.agent, source.path)) {
        const st = await stat(path).catch(() => null);
        if (st && isDue(source, st, cursors.get(path))) {
          await enqueueIngest(source, path, st);
          queued += 1;
        }
      }
    }
    queued += await reingestOutdated();
    await finalizeIdle();
    return queued;
  }

  /**
   * Sessions stored by an older adapter or redaction version are rebuilt from their source file, so
   * parser and redaction fixes reach existing data (legacy token counts included). One job per
   * session and version pair; a source file that is gone leaves the session as it is.
   */
  async function reingestOutdated(): Promise<number> {
    const redactionOn = (await deps.settings.get())['redaction.enabled'];
    const rows = await db
      .selectFrom('session')
      .innerJoin('ingest_cursor', 'ingest_cursor.session_id', 'session.id')
      .innerJoin('source', 'source.id', 'ingest_cursor.source_id')
      .select([
        'session.id',
        'session.agent',
        'session.adapter_version',
        'session.redaction_version',
        'ingest_cursor.source_id',
        'ingest_cursor.file_path',
      ])
      .where('session.workspace_id', '=', workspaceId)
      .where('source.enabled', '=', true)
      .execute();
    let queued = 0;
    for (const r of rows) {
      const adapterVersion = adapterFor(r.agent as Agent).version;
      const outdated =
        r.adapter_version !== adapterVersion ||
        (redactionOn && r.redaction_version !== REDACTION_VERSION);
      if (!outdated || !(await stat(r.file_path).catch(() => null))) continue;
      const id = await deps.queue.enqueue({
        workspaceId,
        kind: INGEST_FILE_JOB,
        payload: { sourceId: r.source_id, path: r.file_path, force: true },
        idempotencyKey: `${INGEST_FILE_JOB}:reingest:${r.id}:${adapterVersion}:${REDACTION_VERSION}`,
        maxAttempts: 2,
      });
      if (id) queued += 1;
    }
    return queued;
  }

  /** Sessions with no new bytes for 10 minutes have ended: compute signals, flag and sample. */
  async function finalizeIdle(): Promise<void> {
    const cutoff = now().getTime() - SESSION_IDLE_MS;
    // Idle: no cursor of the session saw a write since the cutoff. A session without any cursor (pushed
    // redacted, or its source was removed) went quiet when its last event happened.
    const idle = await db
      .selectFrom('session')
      .select('session.id')
      .where('session.workspace_id', '=', workspaceId)
      .where('session.status', '=', 'active')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('ingest_cursor')
              .select('ingest_cursor.file_path')
              .whereRef('ingest_cursor.session_id', '=', 'session.id')
              .where('ingest_cursor.mtime_ms', '>=', cutoff),
          ),
        ),
      )
      .where((eb) =>
        eb.or([
          eb.exists(
            eb
              .selectFrom('ingest_cursor')
              .select('ingest_cursor.file_path')
              .whereRef('ingest_cursor.session_id', '=', 'session.id'),
          ),
          eb(
            eb.fn.coalesce('session.ended_at', 'session.started_at', 'session.created_at'),
            '<',
            new Date(cutoff).toISOString(),
          ),
        ]),
      )
      .execute();
    for (const { id } of idle) await finalizeSession(db, workspaceId, id, now());
  }

  /** History import: every file of every enabled source, in order; idempotent through the cursors. */
  async function importAll(onProgress?: Progress): Promise<{ files: number; events: number }> {
    // Fetch what the buckets hold first; a broken bucket fails the import only after the rest is in.
    const s3Failure = await syncS3().then(
      () => null,
      (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    );
    const work: { source: EnabledSource; path: string }[] = [];
    for (const source of await sources.enabledRows()) {
      for await (const path of listSessionFiles(source.agent, source.path))
        work.push({ source, path });
    }
    const cursorBySource = new Map<string, Awaited<ReturnType<typeof cursorsOf>>>();
    let events = 0;
    let lastReport = 0;
    for (const [i, { source, path }] of work.entries()) {
      if (!cursorBySource.has(source.id)) cursorBySource.set(source.id, await cursorsOf(source.id));
      const st = await stat(path).catch(() => null);
      const cursor = cursorBySource.get(source.id)?.get(path);
      const unchanged = st && cursor?.size === st.size && cursor.mtimeMs === Math.floor(st.mtimeMs);
      if (!unchanged) events += (await ingestFile(pipeline, source, path)).events;
      if (
        onProgress &&
        (Date.now() - lastReport >= PROGRESS_INTERVAL_MS || i === work.length - 1)
      ) {
        lastReport = Date.now();
        await onProgress(i + 1, work.length);
      }
    }
    if (work.length === 0) await onProgress?.(0, 0);
    await finalizeIdle();
    if (s3Failure) throw s3Failure;
    return { files: work.length, events };
  }

  const handlers: Record<string, JobHandler> = {
    [IMPORT_JOB]: {
      concurrency: 1,
      run: async (job) => {
        await importAll((done, total) => deps.queue.setProgress(job.id, { done, total }));
      },
    },
    [INGEST_FILE_JOB]: {
      concurrency: 1,
      run: async (job) => {
        const { sourceId, path, force } = job.payload as {
          sourceId: string;
          path: string;
          force?: boolean;
        };
        const source = (await sources.enabledRows()).find((s) => s.id === sourceId);
        if (!source) return;
        try {
          await ingestFile(pipeline, source, path, { force: force === true });
        } catch (e) {
          // A remove that lands mid-run deletes the source row under the cursor insert (FK); that is a
          // skip. Any other failure, also of a source disabled meanwhile, fails the job.
          const gone = await sources.find(sourceId).then(
            () => false,
            (err: unknown) => err instanceof NotFoundError,
          );
          if (gone) return;
          throw e;
        }
      },
    },
    [RECONCILE_JOB]: {
      concurrency: 1,
      run: async () => {
        await reconcile();
      },
    },
    [S3_SYNC_JOB]: {
      concurrency: 1,
      run: async () => {
        await syncS3();
      },
    },
    [PURGE_JOB]: {
      concurrency: 1,
      run: async () => {
        const days = (await deps.settings.get())['retention.days'];
        await purgePayloads(db, workspaceId, days, now());
        await purgeRawLogs(db, workspaceId, rawLogRoots, days, now());
        await purgeFinishedJobs(db, workspaceId, now());
      },
    },
  };

  const schedules: Schedule[] = [
    { name: 'ingest-reconcile', cron: () => Promise.resolve('* * * * *'), kind: RECONCILE_JOB },
    { name: 'ingest-s3-sync', cron: () => Promise.resolve('* * * * *'), kind: S3_SYNC_JOB },
    { name: 'ingest-purge', cron: () => Promise.resolve('30 3 * * *'), kind: PURGE_JOB },
  ];

  let watcher: SourceWatcher | undefined;
  const timers = new Map<string, NodeJS.Timeout>();

  /** True when the file lies in an enabled source and exists; the ingest job is queued (once per size and mtime). */
  async function onFileEvent(path: string): Promise<boolean> {
    const source = (await sources.enabledRows()).find((s) => path.startsWith(`${s.path}/`));
    if (!source) return false;
    const st = await stat(path).catch(() => null);
    if (!st) return false;
    await enqueueIngest(source, path, st);
    return true;
  }

  /** The source file of a session, only while it still lies inside a registered source (the DB row alone is not trusted). */
  async function rawFile(sessionId: string): Promise<string | null> {
    const path = await sessions.rawPath(sessionId);
    const real = path ? await realpath(path).catch(() => null) : null;
    if (!real) return null;
    for (const source of await sources.list()) {
      const root = await realpath(source.path).catch(() => null);
      if (root && real.startsWith(root + sep)) return real;
    }
    return null;
  }

  /** The real path of a cache folder, refused unless it lies strictly inside the data folder; null when it is gone. */
  /** Stops watching `path`; chokidar's unwatch also drops it for an enabled source that contains it. */
  async function unwatch(path: string): Promise<void> {
    if (!watcher) return;
    watcher.remove(path);
    for (const row of await sources.enabledRows())
      if (path !== row.path && path.startsWith(row.path + sep)) watcher.add(row.path);
  }

  async function cacheDirOf(path: string): Promise<string | null> {
    const real = await realpath(path).catch(() => null);
    if (!real) return null;
    // Only a folder strictly below data/intake or data/s3, never those roots or the rest of /data.
    const roots = await Promise.all(rawLogRoots.map((r) => realpath(r).catch(() => null)));
    if (!roots.some((r) => r !== null && real.startsWith(r + sep)))
      throw new InvalidInputError(
        `"${path}" is not a copy folder in Introspect's data folder; not deleting it`,
      );
    return real;
  }

  const intake = createIntake({
    pipeline,
    dataDir: deps.dataDir,
    addSource: (agent, path, userId) => sources.add(agent, path, { kind: 'intake', userId }),
    onFile: (path) => onFileEvent(path),
  });

  return {
    intake,
    sources: {
      list: (): Promise<SourceDto[]> => sources.list(),
      add: (
        agent: Agent,
        path: string,
        opts?: Parameters<typeof sources.add>[2],
      ): Promise<SourceDto> =>
        sources.add(agent, path, opts).then((dto) => {
          watcher?.add(dto.path);
          return dto;
        }),
      /** Validates that the bucket answers, then caches it under `<dataDir>/s3/<sourceId>`. */
      addS3: async (agent: Agent, given: S3Remote): Promise<SourceDto> => {
        const remote = { ...given, prefix: normalizePrefix(given.prefix) };
        checkEndpoint(remote.endpoint, deps.s3AllowHttp ?? false);
        await probeS3(remote, s3ApiFor(remote)).catch((e: unknown) => {
          throw new InvalidInputError(
            `Cannot read s3://${remote.bucket}/${remote.prefix}: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
        const dto = await sources.addS3(agent, remote, async (id) => {
          const dir = join(deps.dataDir, S3_DIR, id);
          await mkdir(dir, { recursive: true, mode: 0o700 });
          return realpath(dir);
        });
        watcher?.add(dto.path);
        // Fetch now rather than at the next scheduled sync.
        await deps.queue.enqueue({ workspaceId, kind: S3_SYNC_JOB, maxAttempts: 1 });
        return dto;
      },
      setEnabled: async (id: string, enabled: boolean): Promise<SourceDto> => {
        const dto = await sources.setEnabled(id, enabled);
        if (enabled) {
          watcher?.add(dto.path);
          // What changed while the source was off is picked up now, not at the next minute.
          await deps.queue.enqueue({ workspaceId, kind: RECONCILE_JOB, maxAttempts: 1 });
          if (dto.kind === 's3')
            await deps.queue.enqueue({ workspaceId, kind: S3_SYNC_JOB, maxAttempts: 1 });
        } else await unwatch(dto.path);
        return dto;
      },
      /**
       * Deletes the registration; its sessions stay. Our own copies of the logs (S3 cache, intake
       * folder) go too, under the lock that writers of that folder take. Folder sources are the
       * user's files and are never touched.
       */
      remove: async (id: string): Promise<void> => {
        const probe = await sources.find(id);
        const lockKey =
          probe.kind === 's3'
            ? S3_SYNC_JOB
            : probe.kind === 'intake'
              ? `intake-user:${probe.userId}`
              : null;
        const run = async (): Promise<void> => {
          const row = await sources.find(id);
          const cache = row.kind === 'folder' ? null : await cacheDirOf(row.path);
          const removed = await sources.remove(id);
          await unwatch(removed.path);
          if (cache) await rm(cache, { recursive: true, force: true });
        };
        await (lockKey ? withLock(lockKey, run) : run());
      },
      detect: detectSources,
    },
    syncS3,
    sessions,
    rawFile,
    handleFileEvent: onFileEvent,
    handlers,
    schedules,
    pinSession: (id: string) => pinSession(db, workspaceId, id),
    setReference: (id: string, member: boolean, max: number) =>
      setReference(db, workspaceId, id, member, max),
    purgePayloads: (days: number) => purgePayloads(db, workspaceId, days, now()),
    purgeRawLogs: (days: number) => purgeRawLogs(db, workspaceId, rawLogRoots, days, now()),
    reconcile,
    importAll,
    /** Enqueues a history import and returns its job id. */
    startImport: async (): Promise<string> => {
      const id = await deps.queue.enqueue({ workspaceId, kind: IMPORT_JOB, maxAttempts: 2 });
      if (!id) throw new Error('Import job was not created');
      return id;
    },
    startWatching(onError: (e: unknown) => void): void {
      watcher = createWatcher({
        poll: deps.pollMode,
        onFile: (path) => {
          clearTimeout(timers.get(path));
          timers.set(
            path,
            setTimeout(() => {
              timers.delete(path);
              onFileEvent(path).catch(onError);
            }, WATCH_DEBOUNCE_MS),
          );
        },
        onError,
      });
      void sources.enabledRows().then((rows) => {
        for (const r of rows) watcher?.add(r.path);
      }, onError);
    },
    async stopWatching(): Promise<void> {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      await watcher?.close();
      watcher = undefined;
    },
  };
}

export type IngestService = ReturnType<typeof createIngest>;

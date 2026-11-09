import { stat } from 'node:fs/promises';
import type { Db } from '../../platform/db/schema.js';
import type { JobHandler } from '../../platform/jobs/worker.js';
import type { Schedule } from '../../platform/jobs/scheduler.js';
import type { JobQueue } from '../../platform/jobs/queue.js';
import type { SettingsService } from '../settings/index.js';
import { finalizeSession } from './finalize.js';
import { ingestFile, SESSION_IDLE_MS, type PipelineDeps } from './pipeline.js';
import { loadOrCreateRedactionKey } from './redaction.js';
import { purgePayloads, pinSession } from './retention.js';
import { createSessionQueries } from './sessions.js';
import { createSources, detectSources, listSessionFiles, type SourceDto } from './sources.js';
import { createWatcher, type SourceWatcher } from './watcher.js';
import type { Agent } from './types.js';

export type { Agent, EventKind } from './types.js';
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
export { REDACTION_VERSION } from './redaction.js';

export const IMPORT_JOB = 'import_history';
export const INGEST_FILE_JOB = 'ingest_file';
const RECONCILE_JOB = 'reconcile_sources';
const PURGE_JOB = 'purge_payloads';
const WATCH_DEBOUNCE_MS = 2000;
const PROGRESS_INTERVAL_MS = 1000;

export interface IngestDeps {
  db: Db;
  workspaceId: string;
  userId: string;
  dataDir: string;
  settings: Pick<SettingsService, 'get'>;
  queue: Pick<JobQueue, 'enqueue' | 'setProgress'>;
  /** Polling instead of inotify: containers, network and `/mnt/c` mounts. */
  pollMode: boolean;
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
  const sources = createSources(db, workspaceId, deps.userId, deps.pollMode);
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
    await deps.queue.enqueue({
      workspaceId,
      kind: INGEST_FILE_JOB,
      payload: { sourceId: source.id, path },
      // State lives in the key: the same size and mtime means the same work.
      idempotencyKey: `${INGEST_FILE_JOB}:${source.id}:${path}:${String(st.size)}:${String(Math.floor(st.mtimeMs))}`,
    });
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
    await finalizeIdle();
    return queued;
  }

  /** Sessions with no new bytes for 10 minutes have ended: compute signals, flag and sample. */
  async function finalizeIdle(): Promise<void> {
    const cutoff = now().getTime() - SESSION_IDLE_MS;
    const idle = await db
      .selectFrom('session')
      .innerJoin('ingest_cursor', 'ingest_cursor.session_id', 'session.id')
      .select('session.id')
      .where('session.workspace_id', '=', workspaceId)
      .where('session.status', '=', 'active')
      .where('ingest_cursor.mtime_ms', '<', cutoff)
      .execute();
    for (const { id } of idle) await finalizeSession(db, workspaceId, id, now());
  }

  /** History import: every file of every enabled source, in order; idempotent through the cursors. */
  async function importAll(onProgress?: Progress): Promise<{ files: number; events: number }> {
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
        const { sourceId, path } = job.payload as { sourceId: string; path: string };
        const source = (await sources.enabledRows()).find((s) => s.id === sourceId);
        if (source) await ingestFile(pipeline, source, path);
      },
    },
    [RECONCILE_JOB]: {
      concurrency: 1,
      run: async () => {
        await reconcile();
      },
    },
    [PURGE_JOB]: {
      concurrency: 1,
      run: async () => {
        await purgePayloads(db, workspaceId, (await deps.settings.get())['retention.days'], now());
      },
    },
  };

  const schedules: Schedule[] = [
    { name: 'ingest-reconcile', cron: () => Promise.resolve('* * * * *'), kind: RECONCILE_JOB },
    { name: 'ingest-purge', cron: () => Promise.resolve('30 3 * * *'), kind: PURGE_JOB },
  ];

  let watcher: SourceWatcher | undefined;
  const timers = new Map<string, NodeJS.Timeout>();

  async function onFileEvent(path: string): Promise<void> {
    const source = (await sources.enabledRows()).find((s) => path.startsWith(`${s.path}/`));
    if (!source) return;
    const st = await stat(path).catch(() => null);
    if (st) await enqueueIngest(source, path, st);
  }

  return {
    sources: {
      list: (): Promise<SourceDto[]> => sources.list(),
      add: (agent: Agent, path: string): Promise<SourceDto> =>
        sources.add(agent, path).then((dto) => {
          watcher?.add(dto.path);
          return dto;
        }),
      detect: detectSources,
    },
    sessions,
    handlers,
    schedules,
    pinSession: (id: string) => pinSession(db, workspaceId, id),
    purgePayloads: (days: number) => purgePayloads(db, workspaceId, days, now()),
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

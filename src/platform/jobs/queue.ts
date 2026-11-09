import type { DbHandle } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { fromJson, toJson } from '../db/json.js';
import type { Db, JobStatus, Schema } from '../db/schema.js';
import type { Selectable } from 'kysely';

export const LEASE_MS = 5 * 60_000;
export const BACKOFF_BASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const CLAIMABLE: JobStatus[] = ['queued', 'failed', 'deferred'];

export interface Job {
  id: string;
  workspaceId: string;
  kind: string;
  payload: unknown;
  idempotencyKey: string | null;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  leaseUntil: string | null;
  lockedBy: string | null;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
  progress: { done: number; total: number } | null;
}

export interface EnqueueInput {
  workspaceId: string;
  kind: string;
  payload?: unknown;
  /** A second enqueue with the same key is a no-op (ADR-0005). */
  idempotencyKey?: string;
  priority?: number;
  maxAttempts?: number;
  runAfter?: Date;
}

function toJob(row: Selectable<Schema['job']>): Job {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    payload: fromJson(row.payload),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    leaseUntil: row.lease_until,
    lockedBy: row.locked_by,
    lastError: row.last_error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    progress: row.progress === null ? null : (fromJson(row.progress) as Job['progress']),
  };
}

/** `30 s x 2^(attempts-1)`: 30 s after the first failure, 60 s after the second, and so on. */
export function backoffMs(attempts: number): number {
  return BACKOFF_BASE_MS * 2 ** (attempts - 1);
}

export interface JobQueue {
  /** Pass a transaction as `db` to enqueue atomically with the state change that caused the job. Returns null for a duplicate key. */
  enqueue(input: EnqueueInput, db?: Db): Promise<string | null>;
  /** Moves one runnable job to `running` under a lease, or returns null. */
  claim(workerId: string, kinds: string[], now?: Date): Promise<Job | null>;
  heartbeat(jobId: string, workerId: string, now?: Date): Promise<boolean>;
  complete(jobId: string, workerId: string, now?: Date): Promise<void>;
  /** Retry with backoff, or `dead` after the last attempt. */
  fail(jobId: string, workerId: string, error: string, now?: Date): Promise<JobStatus>;
  /** Wait for a budget or time window without consuming an attempt. */
  defer(jobId: string, workerId: string, runAfter: Date): Promise<void>;
  /** Returns jobs whose worker vanished to `queued` (or `dead` when out of attempts). */
  reapExpired(now?: Date): Promise<number>;
  /** The "retry" action for dead jobs in Settings. */
  retryDead(jobId: string, now?: Date): Promise<boolean>;
  /** Long jobs (imports) report how far they are; shown by the SPA. */
  setProgress(jobId: string, progress: { done: number; total: number }): Promise<void>;
  get(jobId: string): Promise<Job | null>;
  /** Newest first; `cursor` is the last id of the previous page. */
  list(opts: { status?: JobStatus; cursor?: string; limit: number }): Promise<Job[]>;
}

export function createJobQueue({ db, dialect }: DbHandle): JobQueue {
  const iso = (d: Date): string => d.toISOString();

  return {
    async enqueue(input, tx = db) {
      const id = newId();
      const now = new Date();
      const inserted = await tx
        .insertInto('job')
        .values({
          id,
          workspace_id: input.workspaceId,
          kind: input.kind,
          payload: toJson(input.payload ?? {}),
          idempotency_key: input.idempotencyKey ?? null,
          priority: input.priority ?? 0,
          max_attempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
          run_after: iso(input.runAfter ?? now),
          created_at: iso(now),
        })
        .onConflict((oc) => oc.column('idempotency_key').doNothing())
        .returning('id')
        .executeTakeFirst();
      return inserted?.id ?? null;
    },

    async claim(workerId, kinds, now = new Date()) {
      if (kinds.length === 0) return null;
      // One statement picks, locks and updates the row. On Postgres the pick is a MATERIALIZED CTE:
      // a plain `id IN (subselect ... LIMIT 1 FOR UPDATE SKIP LOCKED)` may be planned as a join that
      // re-evaluates the subselect per row and so locks and updates more than one job.
      const picked = (qc: Pick<Db, 'selectFrom'>) => {
        const q = qc
          .selectFrom('job')
          .select('id')
          .where('status', 'in', CLAIMABLE)
          .where('run_after', '<=', iso(now))
          .where('kind', 'in', kinds)
          .orderBy('priority', 'desc')
          .orderBy('run_after')
          .orderBy('id')
          .limit(1);
        return dialect === 'postgres' ? q.forUpdate().skipLocked() : q;
      };
      const row = await db
        .with(
          (cte) => cte('picked').materialized(),
          (qc) => picked(qc),
        )
        .updateTable('job')
        .set((eb) => ({
          status: 'running',
          attempts: eb('attempts', '+', 1),
          locked_by: workerId,
          lease_until: iso(new Date(now.getTime() + LEASE_MS)),
        }))
        .where('id', 'in', (eb) => eb.selectFrom('picked').select('id'))
        .returningAll()
        .executeTakeFirst();
      return row ? toJob(row) : null;
    },

    async heartbeat(jobId, workerId, now = new Date()) {
      const r = await db
        .updateTable('job')
        .set({ lease_until: iso(new Date(now.getTime() + LEASE_MS)) })
        .where('id', '=', jobId)
        .where('locked_by', '=', workerId)
        .where('status', '=', 'running')
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },

    async complete(jobId, workerId, now = new Date()) {
      await db
        .updateTable('job')
        .set({ status: 'succeeded', finished_at: iso(now), lease_until: null, locked_by: null })
        .where('id', '=', jobId)
        .where('locked_by', '=', workerId)
        .execute();
    },

    async fail(jobId, workerId, error, now = new Date()) {
      return db.transaction().execute(async (tx) => {
        const job = await tx
          .selectFrom('job')
          .select(['attempts', 'max_attempts'])
          .where('id', '=', jobId)
          .where('locked_by', '=', workerId)
          .executeTakeFirstOrThrow();
        const dead = job.attempts >= job.max_attempts;
        const status: JobStatus = dead ? 'dead' : 'failed';
        await tx
          .updateTable('job')
          .set({
            status,
            last_error: error,
            lease_until: null,
            locked_by: null,
            run_after: iso(new Date(now.getTime() + (dead ? 0 : backoffMs(job.attempts)))),
            finished_at: dead ? iso(now) : null,
          })
          .where('id', '=', jobId)
          .execute();
        return status;
      });
    },

    async defer(jobId, workerId, runAfter) {
      await db
        .updateTable('job')
        .set((eb) => ({
          status: 'deferred',
          attempts: eb('attempts', '-', 1),
          run_after: iso(runAfter),
          lease_until: null,
          locked_by: null,
        }))
        .where('id', '=', jobId)
        .where('locked_by', '=', workerId)
        .execute();
    },

    async reapExpired(now = new Date()) {
      const base = (status: JobStatus, outOfAttempts: boolean) =>
        db
          .updateTable('job')
          .set({
            status,
            locked_by: null,
            lease_until: null,
            last_error: 'lease expired',
            ...(status === 'dead' ? { finished_at: iso(now) } : {}),
          })
          .where('status', '=', 'running')
          .where('lease_until', '<', iso(now))
          .where((eb) =>
            outOfAttempts
              ? eb('attempts', '>=', eb.ref('max_attempts'))
              : eb('attempts', '<', eb.ref('max_attempts')),
          )
          .executeTakeFirst();
      const dead = await base('dead', true);
      const requeued = await base('queued', false);
      return Number(dead.numUpdatedRows + requeued.numUpdatedRows);
    },

    async retryDead(jobId, now = new Date()) {
      const r = await db
        .updateTable('job')
        .set({ status: 'queued', attempts: 0, run_after: iso(now), finished_at: null })
        .where('id', '=', jobId)
        .where('status', '=', 'dead')
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },

    async setProgress(jobId, progress) {
      await db
        .updateTable('job')
        .set({ progress: toJson(progress) })
        .where('id', '=', jobId)
        .execute();
    },

    async get(jobId) {
      const row = await db.selectFrom('job').selectAll().where('id', '=', jobId).executeTakeFirst();
      return row ? toJob(row) : null;
    },

    async list({ status, cursor, limit }) {
      let q = db.selectFrom('job').selectAll().orderBy('id', 'desc').limit(limit);
      if (status) q = q.where('status', '=', status);
      if (cursor) q = q.where('id', '<', cursor);
      return (await q.execute()).map(toJob);
    },
  };
}

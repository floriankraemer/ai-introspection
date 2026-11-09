import type { Db } from '../../platform/db/schema.js';

const DAY_MS = 86_400_000;

/**
 * Removes input and output payloads of sessions that ended before the retention window (ADR-0003).
 * Everything else about the session stays. Pinned and reference-set sessions are never touched.
 */
export async function purgePayloads(
  db: Db,
  workspaceId: string,
  retentionDays: number,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
  const result = await db
    .updateTable('event')
    .set({ input: null, output: null, payload_purged_at: now.toISOString() })
    .where('workspace_id', '=', workspaceId)
    .where('payload_purged_at', 'is', null)
    .where('session_id', 'in', (qb) =>
      qb
        .selectFrom('session')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('pinned', '=', false)
        .where('in_reference_set', '=', false)
        .where('status', '=', 'ended')
        .where((eb) => eb.fn.coalesce('ended_at', 'started_at', 'created_at'), '<', cutoff),
    )
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/** Pins are never removed automatically; `rubrics` and `grading` call this (ADR-0007). */
export async function pinSession(db: Db, workspaceId: string, sessionId: string): Promise<boolean> {
  const result = await db
    .updateTable('session')
    .set({ pinned: true })
    .where('id', '=', sessionId)
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

const FINISHED_JOB_DAYS = 7;

/** Finished jobs (succeeded or dead) are only history; a week is enough to see what happened and to retry. */
export async function purgeFinishedJobs(db: Db, workspaceId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - FINISHED_JOB_DAYS * DAY_MS).toISOString();
  const result = await db
    .deleteFrom('job')
    .where('workspace_id', '=', workspaceId)
    .where('status', 'in', ['succeeded', 'dead'])
    .where('finished_at', '<', cutoff)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

import { lstat, readdir, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PostgresAdapter, type SelectQueryBuilder } from 'kysely';
import type { Db, Schema } from '../../platform/db/schema.js';

const DAY_MS = 86_400_000;
export const TITLE_PURGED = '(title purged)';
const REASON_PURGED = '(reason purged)';

/**
 * Removes input and output payloads, the title and the judge's reasons of sessions that ended before the retention window (ADR-0003).
 * Everything else about the session stays. Pinned and reference-set sessions are never touched.
 */
export async function purgePayloads(
  db: Db,
  workspaceId: string,
  retentionDays: number,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
  const expired = (qb: SelectQueryBuilder<Schema, 'session', object>) =>
    qb
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('pinned', '=', false)
      .where('in_reference_set', '=', false)
      .where('status', '=', 'ended')
      .where((eb) => eb.fn.coalesce('ended_at', 'started_at', 'created_at'), '<', cutoff);
  const result = await db
    .updateTable('event')
    .set({ input: null, output: null, payload_purged_at: now.toISOString() })
    .where('workspace_id', '=', workspaceId)
    .where('payload_purged_at', 'is', null)
    .where('session_id', 'in', (qb) => expired(qb.selectFrom('session')))
    .executeTakeFirst();
  // The title is the first user prompt and the judge's reasons quote the trace: both are payload text too.
  await db
    .updateTable('session')
    .set({ title: TITLE_PURGED })
    .where('id', 'in', (qb) => expired(qb.selectFrom('session')))
    .where('title', 'is not', null)
    .where('title', '!=', TITLE_PURGED)
    .execute();
  await db
    .updateTable('grade')
    .set({ reason: REASON_PURGED })
    .where('workspace_id', '=', workspaceId)
    .where('reason', 'is not', null)
    .where('reason', '!=', REASON_PURGED)
    .where('session_id', 'in', (qb) => expired(qb.selectFrom('session')))
    .execute();
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

/**
 * Adds a session to or removes it from the reference set (build plan: a fixed set re-graded after
 * any change, to see judge drift). Members are pinned. Removal keeps the pin: pins are never
 * removed automatically, and the session may be pinned for a calibration label too.
 */
export async function setReference(
  db: Db,
  workspaceId: string,
  sessionId: string,
  member: boolean,
  max: number,
): Promise<'ok' | 'not_found' | 'full'> {
  return db.transaction().execute(async (tx) => {
    // Two adds at once would both count 19 and both insert: the count and the update must not interleave, so they take a row lock.
    // SQLite has one writer at a time and needs no lock.
    if (member && tx.getExecutor().adapter instanceof PostgresAdapter)
      await tx
        .selectFrom('workspace')
        .select('id')
        .where('id', '=', workspaceId)
        .forUpdate()
        .execute();
    const row = await tx
      .selectFrom('session')
      .select('in_reference_set')
      .where('id', '=', sessionId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    if (!row) return 'not_found';
    if (member && !row.in_reference_set) {
      const { n } = await tx
        .selectFrom('session')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('workspace_id', '=', workspaceId)
        .where('in_reference_set', '=', true)
        .executeTakeFirstOrThrow();
      if (n >= max) return 'full';
    }
    await tx
      .updateTable('session')
      .set({ in_reference_set: member, ...(member && { pinned: true }) })
      .where('id', '=', sessionId)
      .execute();
    return 'ok';
  });
}

/** An unfinished upload or download this old is abandoned. */
const STALE_PART_MS = 3600_000;

/**
 * Deletes raw logs Introspect keeps copies of (intake uploads, S3 caches) once their last write is
 * older than the retention window, and `.part` files older than an hour. Like `purgePayloads`, the
 * files of pinned and reference-set sessions stay, so their raw view keeps working. Logs in the
 * user's own folders are never touched. Returns the number of files deleted.
 */
export async function purgeRawLogs(
  db: Db,
  workspaceId: string,
  roots: readonly string[],
  retentionDays: number,
  now: Date,
): Promise<number> {
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const keep = new Set(
    (
      await db
        .selectFrom('ingest_cursor')
        .innerJoin('session', 'session.id', 'ingest_cursor.session_id')
        .select('ingest_cursor.file_path')
        .where('session.workspace_id', '=', workspaceId)
        .where((eb) =>
          eb.or([eb('session.pinned', '=', true), eb('session.in_reference_set', '=', true)]),
        )
        .execute()
    ).map((r) => r.file_path),
  );
  let deleted = 0;
  for (const given of roots) {
    const root = await realpath(given).catch(() => null);
    if (!root) continue;
    for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      const st = await lstat(path).catch(() => null);
      if (!st) continue;
      const stale = entry.name.endsWith('.part')
        ? st.mtimeMs < now.getTime() - STALE_PART_MS
        : st.mtimeMs < cutoff && !keep.has(path);
      if (
        stale &&
        (await unlink(path).then(
          () => true,
          () => false,
        ))
      )
        deleted += 1;
    }
  }
  return deleted;
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

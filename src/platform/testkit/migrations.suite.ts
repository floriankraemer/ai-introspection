import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateToLatest } from '../db/migrate.js';
import * as sessionOrigin from '../db/migrations/0011_session_origin.js';
import { asBool, fromJson, toJson } from '../db/json.js';
import { newId, sessionId } from '../db/ids.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../identity/index.js';
import type { Schema } from '../db/schema.js';
import type { TestDb, TestDbFactory } from './db.js';

// Keys of Schema, checked against the migrated database so the hand-written types cannot drift.
const TABLES: Record<keyof Schema, true> = {
  workspace: true,
  app_user: true,
  source: true,
  ingest_cursor: true,
  session: true,
  event: true,
  signal: true,
  rubric: true,
  calibration_label: true,
  grade: true,
  proposal: true,
  skill_repo: true,
  cluster_outcome: true,
  improver_run: true,
  change_event: true,
  llm_call: true,
  job: true,
  schedule_state: true,
  setting: true,
  auth_session: true,
  api_token: true,
};

export function migrationsSuite(name: string, make: TestDbFactory): void {
  describe(`migrations and column mapping (${name})`, () => {
    let t: TestDb;
    beforeEach(async () => {
      t = await make();
    });
    afterEach(async () => {
      await t.destroy();
    });

    it('creates every table of the data model', async () => {
      // Postgres introspection lists every schema of the database; keep this test's own.
      const schema =
        t.dialect === 'postgres'
          ? (await sql<{ s: string }>`select current_schema() as s`.execute(t.handle.db)).rows[0]?.s
          : undefined;
      const tables = (await t.handle.db.introspection.getTables())
        .filter((x) => t.dialect === 'sqlite' || x.schema === schema)
        .map((x) => x.name);
      expect(tables.filter((n) => !n.startsWith('kysely_')).sort()).toEqual(
        Object.keys(TABLES).sort(),
      );
    });

    it('is idempotent when run again', async () => {
      await migrateToLatest(t.handle);
    });

    it('seeds the fixed local workspace and user once', async () => {
      const users = await t.handle.db
        .selectFrom('app_user')
        .select(['id', 'workspace_id'])
        .execute();
      expect(users).toEqual([{ id: LOCAL_USER_ID, workspace_id: LOCAL_WORKSPACE_ID }]);
    });

    it('round-trips json, boolean and timestamp values identically on both dialects', async () => {
      const { db } = t.handle;
      const at = '2026-11-09T08:30:00.123Z';
      await db
        .insertInto('session')
        .values({
          id: sessionId('claude-code', 'abc'),
          workspace_id: LOCAL_WORKSPACE_ID,
          user_id: LOCAL_USER_ID,
          agent: 'claude-code',
          native_id: 'abc',
          started_at: at,
          pinned: true,
          ingest_warnings: toJson(['truncated']),
          created_at: at,
        })
        .execute();
      const row = await db.selectFrom('session').selectAll().executeTakeFirstOrThrow();
      expect(row.started_at).toBe(at);
      expect(asBool(row.pinned)).toBe(true);
      expect(asBool(row.flagged)).toBe(false);
      expect(fromJson(row.ingest_warnings)).toEqual(['truncated']);
    });

    it('enforces foreign keys', async () => {
      await expect(
        t.handle.db
          .insertInto('source')
          .values({
            id: newId(),
            workspace_id: LOCAL_WORKSPACE_ID,
            user_id: newId(),
            agent: 'codex',
            path: '/x',
            created_at: new Date().toISOString(),
          })
          .execute(),
      ).rejects.toThrow();
    });

    it('backfills session origin: sessions without a cursor were pushed', async () => {
      const { db } = t.handle;
      const at = new Date().toISOString();
      const session = (nativeId: string) => ({
        id: sessionId('codex', nativeId),
        workspace_id: LOCAL_WORKSPACE_ID,
        user_id: LOCAL_USER_ID,
        agent: 'codex',
        native_id: nativeId,
        created_at: at,
      });
      await db
        .insertInto('session')
        .values([session('from-file'), session('pushed')])
        .execute();
      const sourceId = newId();
      await db
        .insertInto('source')
        .values({
          id: sourceId,
          workspace_id: LOCAL_WORKSPACE_ID,
          user_id: LOCAL_USER_ID,
          agent: 'codex',
          path: '/x',
          created_at: at,
        })
        .execute();
      await db
        .insertInto('ingest_cursor')
        .values({
          workspace_id: LOCAL_WORKSPACE_ID,
          source_id: sourceId,
          file_path: '/x/from-file.jsonl',
          session_id: sessionId('codex', 'from-file'),
          updated_at: at,
        })
        .execute();
      // Back to the state before 0011, then run it over the existing rows.
      await db.schema.alterTable('session').dropColumn('origin').execute();
      await sessionOrigin.up(db as never);
      const rows = await db
        .selectFrom('session')
        .select(['native_id', 'origin'])
        .orderBy('native_id')
        .execute();
      expect(rows).toEqual([
        { native_id: 'from-file', origin: 'file' },
        { native_id: 'pushed', origin: 'pushed' },
      ]);
    });

    it('rejects a second session with the same agent and native id', async () => {
      const insert = () =>
        t.handle.db
          .insertInto('session')
          .values({
            id: newId(),
            workspace_id: LOCAL_WORKSPACE_ID,
            user_id: LOCAL_USER_ID,
            agent: 'codex',
            native_id: 'same',
            created_at: new Date().toISOString(),
          })
          .execute();
      await insert();
      await expect(insert()).rejects.toThrow();
    });
  });
}

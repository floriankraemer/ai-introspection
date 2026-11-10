import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { openDatabase, type DbHandle } from '../db/connection.js';
import { migrateToLatest } from '../db/migrate.js';
import { ensureLocalIdentity } from '../identity/index.js';

/** One isolated, migrated database; `open()` returns further connections to the same data (a second process, in effect). */
export interface TestDb {
  dialect: 'sqlite' | 'postgres';
  handle: DbHandle;
  open(): DbHandle;
  destroy(): Promise<void>;
}

export type TestDbFactory = () => Promise<TestDb>;

export const sqliteTestDb: TestDbFactory = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'introspect-db-'));
  const url = join(dir, 'test.db');
  const handles: DbHandle[] = [];
  const open = (): DbHandle => {
    const h = openDatabase(url);
    handles.push(h);
    return h;
  };
  const handle = open();
  await migrateToLatest(handle);
  await ensureLocalIdentity(handle.db);
  return {
    dialect: 'sqlite',
    handle,
    open,
    destroy: async () => {
      await Promise.all(handles.map((h) => h.close()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

/**
 * A private database per test. A schema per test is not enough: Kysely's migrator and `introspection`
 * look at every schema of the database, so one process dropping its schema made another's migration
 * fail with 3F000 "schema does not exist".
 */
export const postgresTestDb: TestDbFactory = async () => {
  const base = process.env.INTROSPECT_TEST_DATABASE_URL;
  if (!base) throw new Error('INTROSPECT_TEST_DATABASE_URL is not set; run via `make test-pg`');
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const handles: DbHandle[] = [];
  const open = (): DbHandle => {
    const h = openDatabase(url.toString());
    handles.push(h);
    return h;
  };
  const handle = open();
  await migrateToLatest(handle);
  await ensureLocalIdentity(handle.db);
  return {
    dialect: 'postgres',
    handle,
    open,
    destroy: async () => {
      await Promise.all(handles.map((h) => h.close()));
      await dropWhenIdle(admin, name);
      await admin.end();
    },
  };
};

/**
 * `with (force)` would kill backends whose client is still closing, which surfaces as an unhandled 57P01
 * pool error in the test run. A plain drop fails with 55006 until the closed connections have gone; retry.
 */
async function dropWhenIdle(admin: pg.Client, name: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.query(`drop database ${name}`);
      return;
    } catch (e) {
      const inUse = (e as { code?: string }).code === '55006';
      if (!inUse || attempt >= 100) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

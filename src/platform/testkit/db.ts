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

/** A private schema per test keeps parallel test files from seeing each other's rows. */
export const postgresTestDb: TestDbFactory = async () => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set; run via `make test-pg`');
  const schema = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
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
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    },
  };
};

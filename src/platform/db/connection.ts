import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CompiledQuery,
  Kysely,
  PostgresDialect,
  SqliteDialect,
  SqliteDriver,
  type DatabaseConnection,
  type Driver,
  type SqliteDatabase,
} from 'kysely';
import pg from 'pg';
import type { Db, Dialect, Schema } from './schema.js';

export interface DbHandle {
  db: Db;
  dialect: Dialect;
  close(): Promise<void>;
}

const POSTGRES_URL = /^postgres(ql)?:\/\//;

export function dialectOf(databaseUrl: string): Dialect {
  return POSTGRES_URL.test(databaseUrl) ? 'postgres' : 'sqlite';
}

/** Postgres and SQLite must hand the same JS values to the repositories: ISO strings and numbers. */
function openPostgres(url: string): DbHandle {
  const pool = new pg.Pool({
    connectionString: url,
    types: {
      getTypeParser: ((oid: Parameters<typeof pg.types.getTypeParser>[0], format?: 'text') => {
        if (oid === pg.types.builtins.TIMESTAMPTZ) return (v: string) => new Date(v).toISOString();
        if (oid === pg.types.builtins.INT8) return (v: string) => Number(v); // byte offsets stay far below 2^53
        return pg.types.getTypeParser(oid, format) as (v: string) => unknown;
      }) as typeof pg.types.getTypeParser,
    },
  });
  const db = new Kysely<Schema>({ dialect: new PostgresDialect({ pool }) });
  return { db, dialect: 'postgres', close: () => db.destroy() };
}

/** better-sqlite3 refuses boolean bindings; Postgres accepts them. Map them so callers write booleans on both. */
function bindable(params: readonly unknown[]): unknown[] {
  return params.map((p) => (typeof p === 'boolean' ? Number(p) : p));
}

function wrapSqlite(raw: Database.Database): SqliteDatabase {
  return {
    close: () => {
      raw.close();
    },
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      return {
        reader: stmt.reader,
        all: (p) => stmt.all(...bindable(p)),
        run: (p) => stmt.run(...bindable(p)),
        iterate: (p) => stmt.iterate(...bindable(p)),
      };
    },
  };
}

/** A deferred BEGIN that later upgrades to a write fails with SQLITE_BUSY when another process wrote meanwhile. */
class ImmediateSqliteDriver extends SqliteDriver {
  override async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin immediate'));
  }
}

class ImmediateSqliteDialect extends SqliteDialect {
  override createDriver(): Driver {
    return new ImmediateSqliteDriver({ database: this.#database });
  }
  readonly #database: SqliteDatabase;
  constructor(database: SqliteDatabase) {
    super({ database });
    this.#database = database;
  }
}

/** The data directory and the database files are for this user only: they hold traces. */
function openSqlite(path: string): DbHandle {
  const files = [path, `${path}-wal`, `${path}-shm`];
  const priv = path !== ':memory:';
  if (priv) {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A container volume root belongs to root and stays as it is; our own folder is tightened.
    if (statSync(dir).uid === process.getuid?.()) chmodSync(dir, 0o700);
    for (const f of files) if (existsSync(f)) chmodSync(f, 0o600);
  }
  // SQLite creates the WAL and SHM files with the mode of the database file, and the database with the umask.
  const oldMask = priv ? process.umask(0o077) : undefined;
  let raw: Database.Database;
  try {
    raw = new Database(path);
    // auto_vacuum only takes effect on a fresh file, before the first table exists (ADR-0003).
    raw.pragma('auto_vacuum = INCREMENTAL');
    raw.pragma('journal_mode = WAL');
  } finally {
    if (oldMask !== undefined) process.umask(oldMask);
  }
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');
  // Purged payloads and titles are overwritten with zeros, not left in free pages.
  raw.pragma('secure_delete = ON');
  raw.pragma('busy_timeout = 5000');
  const db = new Kysely<Schema>({ dialect: new ImmediateSqliteDialect(wrapSqlite(raw)) });
  return { db, dialect: 'sqlite', close: () => db.destroy() };
}

export function openDatabase(databaseUrl: string): DbHandle {
  return dialectOf(databaseUrl) === 'postgres'
    ? openPostgres(databaseUrl)
    : openSqlite(databaseUrl);
}

import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';

const mode = (path: string): number => statSync(path).mode & 0o777;

describe('SQLite files', () => {
  it('are private: 0700 data dir, 0600 database, WAL and SHM, also when they existed with looser modes', async () => {
    const old = process.umask(0o022);
    try {
      const dir = join(mkdtempSync(join(tmpdir(), 'introspect-db-')), 'data');
      mkdirSync(dir, { mode: 0o755 });
      const file = join(dir, 'i.db');
      for (const f of [file, `${file}-wal`, `${file}-shm`]) {
        writeFileSync(f, '');
        chmodSync(f, 0o644);
      }
      // An empty file is a valid new database; WAL and SHM of a closed database are recreated.
      const h = openDatabase(file);
      await sql`create table t (x text)`.execute(h.db);
      await sql`insert into t values ('a')`.execute(h.db);
      expect(mode(dir)).toBe(0o700);
      for (const f of [file, `${file}-wal`, `${file}-shm`]) expect(mode(f), f).toBe(0o600);
      await h.close();
      const fresh = join(dir, 'fresh.db');
      const h2 = openDatabase(fresh);
      await sql`create table t (x text)`.execute(h2.db);
      for (const f of [fresh, `${fresh}-wal`, `${fresh}-shm`]) expect(mode(f), f).toBe(0o600);
      await h2.close();
    } finally {
      process.umask(old);
    }
  });
});
